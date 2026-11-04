import { redirect } from "react-router";

// Temporary (302) so a later change of landing page is not pinned in caches.
export const loader = () => redirect("/services");
