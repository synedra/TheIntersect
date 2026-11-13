import os
import time
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import requests
from dotenv import load_dotenv
from astrapy import DataAPIClient

# Load local .env values if present
load_dotenv()

HARDCOVER_API_URL = os.getenv("HARDCOVER_API_URL", "https://api.hardcover.app/v1/graphql")
HARDCOVER_API_TOKEN = (
    os.getenv("HARDCOVER_API_TOKEN")
    or os.getenv("HARDCOVER_TOKEN")
    or os.getenv("HARDCOVER_BEARER_TOKEN")
)

ASTRA_DB_API_ENDPOINT = os.getenv("ASTRA_DB_API_ENDPOINT")
ASTRA_DB_APPLICATION_TOKEN = os.getenv("ASTRA_DB_APPLICATION_TOKEN")

BOOKS_COLLECTION = "books2026"
METADATA_COLLECTION = "crawler_metadata_books_2026"
PROGRESS_DOC_ID = "hardcover_books_progress"

REQUEST_TIMEOUT_SECONDS = 30
DEFAULT_PAGE_SIZE = int(os.getenv("HARDCOVER_PAGE_SIZE", "200"))
SLEEP_BETWEEN_REQUESTS_SECONDS = float(os.getenv("HARDCOVER_REQUEST_DELAY", "0.15"))


class HardcoverSyncError(Exception):
    pass


def require_env() -> None:
    if not HARDCOVER_API_TOKEN:
        raise HardcoverSyncError(
            "Missing Hardcover token. Set HARDCOVER_API_TOKEN (or HARDCOVER_TOKEN / HARDCOVER_BEARER_TOKEN)."
        )
    if not ASTRA_DB_API_ENDPOINT:
        raise HardcoverSyncError("Missing ASTRA_DB_API_ENDPOINT in environment.")
    if not ASTRA_DB_APPLICATION_TOKEN:
        raise HardcoverSyncError("Missing ASTRA_DB_APPLICATION_TOKEN in environment.")


def gql_request(query: str, variables: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    response = requests.post(
        HARDCOVER_API_URL,
        headers={
            "Authorization": f"Bearer {HARDCOVER_API_TOKEN}",
            "Content-Type": "application/json",
        },
        json={"query": query, "variables": variables or {}},
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    payload = response.json()

    if payload.get("errors"):
        message = "; ".join(err.get("message", str(err)) for err in payload["errors"])
        raise HardcoverSyncError(f"GraphQL error: {message}")

    data = payload.get("data")
    if data is None:
        raise HardcoverSyncError(f"GraphQL response missing data: {payload}")

    return data


def unwrap_named_type(type_ref: Dict[str, Any]) -> Optional[str]:
    ref = type_ref
    while ref and ref.get("kind") in {"NON_NULL", "LIST"}:
        ref = ref.get("ofType")
    return ref.get("name") if ref else None


def is_required_arg(arg: Dict[str, Any]) -> bool:
    return arg.get("type", {}).get("kind") == "NON_NULL" and arg.get("defaultValue") is None


def get_schema() -> Dict[str, Any]:
    introspection_query = """
    query IntrospectSchema {
      __schema {
        queryType { name }
        types {
          kind
          name
          fields(includeDeprecated: true) {
            name
            args {
              name
              defaultValue
              type {
                kind
                name
                ofType {
                  kind
                  name
                  ofType {
                    kind
                    name
                    ofType {
                      kind
                      name
                      ofType {
                        kind
                        name
                        ofType {
                          kind
                          name
                        }
                      }
                    }
                  }
                }
              }
            }
            type {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                  ofType {
                    kind
                    name
                    ofType {
                      kind
                      name
                      ofType {
                        kind
                        name
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    """
    return gql_request(introspection_query)


def build_type_maps(schema_data: Dict[str, Any]) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    schema = schema_data["__schema"]
    types = {t["name"]: t for t in schema.get("types", []) if t.get("name")}

    query_type_name = schema["queryType"]["name"]
    query_type = types.get(query_type_name, {})
    query_fields = {f["name"]: f for f in query_type.get("fields", []) or []}

    return types, query_fields


def resolve_books_query_field(query_fields: Dict[str, Dict[str, Any]]) -> Tuple[str, Dict[str, Any]]:
    if "books" in query_fields:
        return "books", query_fields["books"]

    candidates = [
        (name, field)
        for name, field in query_fields.items()
        if "book" in name.lower() and name.lower() != "books_aggregate"
    ]
    if not candidates:
        raise HardcoverSyncError("Could not find a books field in Hardcover GraphQL query type.")

    # Prefer fields that return list-like structures
    candidates.sort(key=lambda item: ("books" != item[0], item[0]))
    return candidates[0]


def build_books_selection(types: Dict[str, Dict[str, Any]], books_field: Dict[str, Any]) -> str:
    scalar_kinds = {"SCALAR", "ENUM"}
    books_type_name = unwrap_named_type(books_field["type"])
    if not books_type_name:
        raise HardcoverSyncError("Could not resolve books return type.")

    books_type = types.get(books_type_name)
    if not books_type:
        raise HardcoverSyncError(f"Could not resolve books type '{books_type_name}'.")

    # If connection type, try to target node type
    if books_type.get("kind") == "OBJECT" and any((books_type.get("fields") or [])):
        field_names = {f.get("name") for f in books_type.get("fields", [])}
        if "edges" in field_names:
            return "edges { node { id title slug description } } pageInfo { hasNextPage endCursor }"
        if "nodes" in field_names:
            return "nodes { id title slug description }"

    selections: List[str] = []
    for field in books_type.get("fields", []) or []:
        if not field:
            continue

        field_name = field.get("name")
        if not field_name or field_name.startswith("_"):
            continue

        if any(is_required_arg(arg) for arg in field.get("args", [])):
            continue

        field_type_name = unwrap_named_type(field.get("type", {}))
        if not field_type_name:
            continue

        type_def = types.get(field_type_name, {})
        type_kind = type_def.get("kind")

        if type_kind in scalar_kinds:
            selections.append(field_name)
            continue

        # Include one nested level of scalar fields for object/list fields
        if type_kind == "OBJECT":
            subfields = []
            for sub in type_def.get("fields", []) or []:
                if any(is_required_arg(arg) for arg in sub.get("args", [])):
                    continue
                sub_name = sub.get("name")
                sub_type_name = unwrap_named_type(sub.get("type", {}))
                sub_type_def = types.get(sub_type_name or "", {})
                if sub_name and sub_type_def.get("kind") in scalar_kinds and not sub_name.startswith("_"):
                    subfields.append(sub_name)
                if len(subfields) >= 8:
                    break

            if subfields:
                selections.append(f"{field_name} {{ {' '.join(subfields)} }}")

    # Guarantee useful baseline fields if available
    preferred = ["id", "title", "slug", "description", "release_date", "image_url"]
    existing_base = {s.split(" {", 1)[0] for s in selections}
    for name in preferred:
        if name in existing_base:
            continue
        if any(f.get("name") == name for f in books_type.get("fields", []) or []):
            selections.insert(0, name)

    if not selections:
        raise HardcoverSyncError("No selectable book fields were found during schema introspection.")

    return "\n      ".join(selections)


def extract_rows(result: Any) -> List[Dict[str, Any]]:
    if isinstance(result, list):
        return [row for row in result if isinstance(row, dict)]

    if isinstance(result, dict):
        if isinstance(result.get("nodes"), list):
            return [row for row in result["nodes"] if isinstance(row, dict)]
        if isinstance(result.get("items"), list):
            return [row for row in result["items"] if isinstance(row, dict)]
        if isinstance(result.get("edges"), list):
            rows = []
            for edge in result["edges"]:
                if isinstance(edge, dict) and isinstance(edge.get("node"), dict):
                    rows.append(edge["node"])
            return rows

    return []


def deep_collect_names(value: Any) -> List[str]:
    found: List[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for k, v in node.items():
                if k in {"name", "title"} and isinstance(v, str) and v.strip():
                    found.append(v.strip())
                else:
                    walk(v)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(value)
    seen = set()
    deduped = []
    for n in found:
        key = n.lower()
        if key not in seen:
            seen.add(key)
            deduped.append(n)
    return deduped


def build_document(book: Dict[str, Any], row_offset: int) -> Dict[str, Any]:
    hardcover_id = book.get("id")
    slug = book.get("slug")
    title = book.get("title") or book.get("name")

    doc_id = str(hardcover_id) if hardcover_id is not None else f"hardcover-{row_offset}"

    authors = deep_collect_names(book.get("authors") or book.get("contributions") or [])
    genres = deep_collect_names(book.get("genres") or book.get("genre") or [])

    return {
        "_id": doc_id,
        "hardcover_id": hardcover_id,
        "source": "hardcover",
        "title": title,
        "title_lower": title.lower() if isinstance(title, str) else None,
        "slug": slug,
        "description": book.get("description"),
        "authors": authors,
        "genres": genres,
        "raw_hardcover": book,
        "indexed_at": datetime.utcnow().isoformat(),
    }


def upsert_progress(metadata_collection: Any, payload: Dict[str, Any]) -> None:
    metadata_collection.find_one_and_update(
        {"_id": PROGRESS_DOC_ID},
        {"$set": payload},
        upsert=True,
    )


def get_progress(metadata_collection: Any) -> Dict[str, Any]:
    current = metadata_collection.find_one({"_id": PROGRESS_DOC_ID})
    return current if isinstance(current, dict) else {}


def init_astra() -> Tuple[Any, Any]:
    client = DataAPIClient(ASTRA_DB_APPLICATION_TOKEN)
    database = client.get_database(ASTRA_DB_API_ENDPOINT)

    try:
        books_collection = database.create_collection(
            BOOKS_COLLECTION,
        )
        print(f"✅ Created collection: {BOOKS_COLLECTION}")
    except Exception as exc:
        if "already exists" in str(exc).lower():
            books_collection = database.get_collection(BOOKS_COLLECTION)
            print(f"✅ Using existing collection: {BOOKS_COLLECTION}")
        else:
            raise

    try:
        metadata_collection = database.create_collection(METADATA_COLLECTION)
        print(f"✅ Created collection: {METADATA_COLLECTION}")
    except Exception as exc:
        if "already exists" in str(exc).lower():
            metadata_collection = database.get_collection(METADATA_COLLECTION)
            print(f"✅ Using existing collection: {METADATA_COLLECTION}")
        else:
            raise

    return books_collection, metadata_collection


def sync_books(max_books: Optional[int] = None, page_size: int = DEFAULT_PAGE_SIZE) -> None:
    require_env()

    books_collection, metadata_collection = init_astra()

    print("🔎 Introspecting Hardcover GraphQL schema...")
    schema_data = get_schema()
    types, query_fields = build_type_maps(schema_data)

    books_field_name, books_field = resolve_books_query_field(query_fields)
    books_selection = build_books_selection(types, books_field)

    arg_names = {arg["name"] for arg in books_field.get("args", [])}
    supports_limit_offset = "limit" in arg_names and "offset" in arg_names
    supports_page = "page" in arg_names

    if not supports_limit_offset and not supports_page:
        raise HardcoverSyncError(
            f"Unsupported books pagination args for field '{books_field_name}': {sorted(arg_names)}"
        )

    progress = get_progress(metadata_collection)
    completed = bool(progress.get("completed"))

    if completed:
        print("ℹ️ Previous run is marked complete. Starting from the beginning.")

    offset = int(progress.get("offset", 0)) if not completed else 0
    page = int(progress.get("page", 1)) if not completed else 1
    processed = int(progress.get("processed", 0)) if not completed else 0

    print(
        f"🚀 Syncing Hardcover books into Astra '{BOOKS_COLLECTION}' using field '{books_field_name}' "
        f"(page_size={page_size}, start_offset={offset}, start_page={page})"
    )

    while True:
        if max_books is not None and processed >= max_books:
            print(f"⏹ Reached max_books={max_books}. Stopping.")
            break

        vars_decl = []
        args_expr = []
        variables: Dict[str, Any] = {}

        if supports_limit_offset:
            vars_decl.extend(["$limit: Int!", "$offset: Int!"])
            args_expr.extend(["limit: $limit", "offset: $offset"])
            remaining = None if max_books is None else max_books - processed
            this_limit = page_size if remaining is None else max(0, min(page_size, remaining))
            if this_limit <= 0:
                break
            variables["limit"] = this_limit
            variables["offset"] = offset
        elif supports_page:
            vars_decl.extend(["$page: Int!"])
            args_expr.append("page: $page")
            variables["page"] = page
            if "per_page" in arg_names:
                vars_decl.append("$per_page: Int!")
                remaining = None if max_books is None else max_books - processed
                this_limit = page_size if remaining is None else max(0, min(page_size, remaining))
                if this_limit <= 0:
                    break
                variables["per_page"] = this_limit
                args_expr.append("per_page: $per_page")

        query = f"""
        query FetchBooks({', '.join(vars_decl)}) {{
          {books_field_name}({', '.join(args_expr)}) {{
            {books_selection}
          }}
        }}
        """

        data = gql_request(query, variables)
        rows = extract_rows(data.get(books_field_name))

        if not rows:
            print("✅ No more books returned; sync complete.")
            break

        for i, row in enumerate(rows):
            row_offset = offset + i if supports_limit_offset else processed + i
            document = build_document(row, row_offset=row_offset)

            books_collection.find_one_and_replace(
                {"_id": document["_id"]},
                document,
                upsert=True,
            )

        processed += len(rows)

        if supports_limit_offset:
            offset += len(rows)
        else:
            page += 1

        upsert_progress(
            metadata_collection,
            {
                "offset": offset,
                "page": page,
                "processed": processed,
                "completed": False,
                "updated_at": datetime.utcnow().isoformat(),
                "books_field": books_field_name,
                "page_size": page_size,
            },
        )

        print(f"📚 Upserted {len(rows)} books (total: {processed})")
        time.sleep(SLEEP_BETWEEN_REQUESTS_SECONDS)

    upsert_progress(
        metadata_collection,
        {
            "offset": offset,
            "page": page,
            "processed": processed,
            "completed": True,
            "updated_at": datetime.utcnow().isoformat(),
            "books_field": books_field_name,
            "page_size": page_size,
        },
    )

    print(f"🎉 Finished syncing books into '{BOOKS_COLLECTION}'. Total processed: {processed}")


if __name__ == "__main__":
    # Optional controls via env:
    #   HARDCOVER_MAX_BOOKS=5000
    #   HARDCOVER_PAGE_SIZE=200
    max_books_env = os.getenv("HARDCOVER_MAX_BOOKS")
    max_books = int(max_books_env) if max_books_env else None
    sync_books(max_books=max_books, page_size=DEFAULT_PAGE_SIZE)
