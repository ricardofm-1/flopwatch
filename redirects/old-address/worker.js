// Permanent redirect from the retired address (flop-miner-board.ricfmartins.workers.dev) to Flopwatch.
// GET/HEAD get 301; other methods get 308 so agents' POST bodies survive the redirect.
const TARGET = "https://flopwatch.ricfmartins.workers.dev";
export default {
  fetch(request) {
    const url = new URL(request.url);
    const status = request.method === "GET" || request.method === "HEAD" ? 301 : 308;
    return new Response(null, {
      status,
      headers: { location: TARGET + url.pathname + url.search, "cache-control": "public, max-age=86400" },
    });
  },
};
