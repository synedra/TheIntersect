const output = document.getElementById("output")

fetch(
  "/.netlify/functions/api?endpoint=discover/movie?page=1&sort_by=popularity.desc"
)
  .then(res => res.json())
  .then(data => {
    output.textContent = JSON.stringify(data.results.slice(0, 5), null, 2)
  })
  .catch(err => {
    output.textContent = err.message
  })

