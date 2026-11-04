/** Liveness for the container: the server answers. Routes are not checked here. */
export const loader = () => new Response("ok\n", { headers: { "Content-Type": "text/plain" } });
