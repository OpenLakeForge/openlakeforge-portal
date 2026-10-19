import type { APIRoute } from "astro";

/** Liveness for the container: the server answers. Routes are not checked here. */
export const GET: APIRoute = () => new Response("ok\n", { headers: { "Content-Type": "text/plain" } });
