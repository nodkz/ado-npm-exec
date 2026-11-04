// A fetch that answers from a route table (URL -> handler) and records each call.

/**
 * @param {Record<string, (init: RequestInit) => Response | Promise<Response>>} routes
 */
export function fakeFetch(routes) {
  /** @type {{ url: string, init: RequestInit }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const impl = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url];
    return route ? route(init) : new Response('{"error":"not found"}', { status: 404 });
  };
  return { calls, impl };
}
