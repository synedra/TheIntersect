(function(){const e=document.createElement("link").relList;if(e&&e.supports&&e.supports("modulepreload"))return;for(const s of document.querySelectorAll('link[rel="modulepreload"]'))a(s);new MutationObserver(s=>{for(const n of s)if(n.type==="childList")for(const d of n.addedNodes)d.tagName==="LINK"&&d.rel==="modulepreload"&&a(d)}).observe(document,{childList:!0,subtree:!0});function i(s){const n={};return s.integrity&&(n.integrity=s.integrity),s.referrerPolicy&&(n.referrerPolicy=s.referrerPolicy),s.crossOrigin==="use-credentials"?n.credentials="include":s.crossOrigin==="anonymous"?n.credentials="omit":n.credentials="same-origin",n}function a(s){if(s.ep)return;s.ep=!0;const n=i(s);fetch(s.href,n)}})();const w=document.getElementById("output"),N=document.getElementById("status"),p=document.getElementById("searchInput"),S=document.getElementById("suggestions"),M=document.getElementById("chips"),A=document.getElementById("clear"),g=document.getElementById("modalOverlay"),O=document.getElementById("modalClose"),$=document.getElementById("modalTitle"),k=document.getElementById("modalSubtitle"),h=document.getElementById("modalBody");let _=[],c=[],I=null,b=0;const C="https://image.tmdb.org/t/p/w342";function m(t){N.textContent=t||""}function o(t){return String(t).replace(/[&<>"']/g,function(e){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[e]})}function y(t){return t.type+":"+t.id}function f(t){S.style.display=t?"block":"none",t||(S.innerHTML="")}function H(t,e,i){const a={type:t,id:String(e),name:String(i)};c.some(n=>y(n)===y(a))||(c.push(a),L(),v())}function j(t){c=c.filter(e=>y(e)!==t),L(),v()}async function u(t,e){const i=new URLSearchParams(Object.assign({path:t},e||{})),a=await fetch("/.netlify/functions/api?"+i.toString()),s=await a.text();if(s.trim().startsWith("<"))throw new Error("Function returned HTML (wrong server/route). Use http://localhost:8888 with netlify dev.");let n;try{n=JSON.parse(s)}catch{throw new Error("JSON parse failed. First chars: "+s.slice(0,80))}if(!a.ok)throw new Error(n&&(n.status_message||n.error)||"HTTP "+a.status);return n}function L(){M.innerHTML=c.map(t=>`
    <span class="chip" data-key="${y(t)}">
      ${o(t.name)}
      <span class="chipType">${o(t.type)}</span>
      <button type="button" aria-label="Remove">×</button>
    </span>
  `).join("")}M.addEventListener("click",t=>{const e=t.target.closest(".chip");e&&t.target.tagName==="BUTTON"&&j(e.getAttribute("data-key"))});function P(t){if(!t.length){f(!1);return}S.innerHTML=t.map(e=>`
    <div class="resultItem" data-type="${e.type}" data-id="${e.id}" data-name="${o(e.name)}">
      <span>${o(e.name)}</span>
      <span class="suggestionType">${o(e.type)}</span>
    </div>
  `).join(""),f(!0)}S.addEventListener("click",t=>{const e=t.target.closest(".resultItem");if(!e)return;const i=e.getAttribute("data-type"),a=e.getAttribute("data-id"),s=e.getAttribute("data-name");H(i,a,s),p.value="",f(!1),p.focus()});document.addEventListener("click",t=>{t.target.closest(".searchBox")||t.target.closest("#suggestions")||f(!1)});async function q(){_=(await u("genre/movie/list",{language:"en-US"})).genres||[]}function U(t){return t.split(",").pop().trim()}async function F(t){const e=U(t);if(e.length<2)return[];const i=e.toLowerCase(),a=_.filter(r=>r.name.toLowerCase().includes(i)).slice(0,6).map(r=>({type:"genre",id:String(r.id),name:r.name})),[s,n]=await Promise.all([u("search/person",{query:e,include_adult:"false",language:"en-US",page:"1"}),u("search/keyword",{query:e,page:"1"})]),d=(s.results||[]).slice(0,6).map(r=>({type:"person",id:String(r.id),name:r.name})),E=(n.results||[]).slice(0,6).map(r=>({type:"keyword",id:String(r.id),name:r.name})),B=new Set(c.map(y));return[...d,...a,...E].filter(r=>!B.has(y(r)))}p.addEventListener("input",()=>{clearTimeout(I);const t=p.value;I=setTimeout(()=>{F(t).then(P).catch(e=>{m((e==null?void 0:e.message)||String(e)),f(!1)})},250)});p.addEventListener("keydown",t=>{t.key==="Enter"&&(t.preventDefault(),v()),t.key==="Backspace"&&!p.value&&c.length&&(c.pop(),L(),v())});function R(t){if(!(t!=null&&t.length)){w.textContent="No results.";return}w.innerHTML=`
    <div class="grid">
      ${t.slice(0,20).map(e=>`
        <div class="card" data-movie-id="${e.id}">
          ${e.poster_path?`<img src="${C}${e.poster_path}" alt="${o(e.title)}" />`:'<div class="noposter">No poster</div>'}
          <div class="movieTitle">${o(e.title)}</div>
          <div class="meta">${o(e.release_date||"")}</div>
        </div>
      `).join("")}
    </div>
  `}w.addEventListener("click",t=>{const e=t.target.closest(".card[data-movie-id]");if(!e)return;const i=e.getAttribute("data-movie-id");K(i)});function G(){g.classList.add("open"),g.setAttribute("aria-hidden","false")}function x(){g.classList.remove("open"),g.setAttribute("aria-hidden","true"),h.innerHTML=""}O.addEventListener("click",x);g.addEventListener("click",t=>{t.target===g&&x()});document.addEventListener("keydown",t=>{t.key==="Escape"&&g.classList.contains("open")&&x()});h.addEventListener("click",t=>{const e=t.target.closest(".pill");if(!e)return;const i=e.getAttribute("data-type"),a=e.getAttribute("data-id"),s=e.getAttribute("data-name");H(i,a,s)});function T(t,e,i){return`<span class="pill" data-type="${t}" data-id="${String(e)}" data-name="${o(String(i))}">${o(String(i))}</span>`}async function K(t){G(),$.textContent="Loading…",k.textContent="",h.innerHTML="";try{const[e,i,a]=await Promise.all([u(`movie/${t}`,{language:"en-US"}),u(`movie/${t}/credits`,{language:"en-US"}),u(`movie/${t}/keywords`,{})]);$.textContent=e.title||"Movie",k.textContent=[e.release_date?e.release_date.slice(0,4):"",e.runtime?`${e.runtime} min`:"",e.vote_average?`⭐ ${e.vote_average.toFixed(1)}`:""].filter(Boolean).join(" • ");const s=e.poster_path?`<img src="${C}${e.poster_path}" alt="${o(e.title)}" />`:'<div class="noposter" style="height:320px;">No poster</div>',n=(e.genres||[]).map(l=>T("genre",l.id,l.name)).join(""),E=(i.cast||[]).slice(0,10).map(l=>T("person",l.id,l.name)).join(""),r=(a.keywords||a.results||[]).slice(0,12).map(l=>T("keyword",l.id,l.name)).join("");h.innerHTML=`
      <div class="poster">${s}</div>
      <div>
        <div class="overview">${o(e.overview||"No overview available.")}</div>

        <div class="sectionTitle">Genres (click to add)</div>
        <div class="pillRow">${n||"<span class='subtle'>None</span>"}</div>

        <div class="sectionTitle">Top cast (click to add)</div>
        <div class="pillRow">${E||"<span class='subtle'>None</span>"}</div>

        <div class="sectionTitle">Keywords (click to add)</div>
        <div class="pillRow">${r||"<span class='subtle'>None</span>"}</div>

        <div class="subtle" style="margin-top:14px;">
          Tip: click any genre/person/keyword above to refine the search instantly.
        </div>
      </div>
    `}catch(e){$.textContent="Error",k.textContent="",h.innerHTML=`<div style="padding:16px;">${o((e==null?void 0:e.message)||String(e))}</div>`}}async function v(){const t=++b;m("Loading…"),w.textContent="Loading…";const e=c.filter(n=>n.type==="person").map(n=>n.id),i=c.filter(n=>n.type==="genre").map(n=>n.id),a=c.filter(n=>n.type==="keyword").map(n=>n.id),s={include_adult:"false",page:"1",sort_by:"popularity.desc"};e.length&&(s.with_cast=e.join(",")),i.length&&(s.with_genres=i.join(",")),a.length&&(s.with_keywords=a.join(","));try{const n=await u("discover/movie",s);if(t!==b)return;R(n.results||[]),m("Showing "+(n.results||[]).length+" results")}catch(n){if(t!==b)return;w.textContent=(n==null?void 0:n.message)||String(n),m("Error")}}A.addEventListener("click",()=>{c=[],L(),p.value="",f(!1),m(""),v()});async function D(){try{await q()}catch(t){m((t==null?void 0:t.message)||String(t))}v()}D();
