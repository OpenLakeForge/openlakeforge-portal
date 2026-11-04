import { isRouteErrorResponse, Meta, Outlet, Scripts, useRouteError } from "react-router";
import fonts from "./styles/fonts.css?inline";
import tokens from "./styles/tokens.css?inline";
import global from "./styles/global.css?inline";
import portal from "./styles/portal.css?inline";
import queries from "./styles/queries.css?inline";

// OpenLakeForge's e2e check counts the href attributes on the landing page as
// routes, so the CSS is inlined rather than linked. <Scripts/> hydrates the
// page (the query workspace needs it), at the cost of the module preload links.
export const meta = () => [{ title: "OpenLakeForge" }];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="dark light" />
        <Meta />
        <style dangerouslySetInnerHTML={{ __html: [fonts, tokens, global, portal, queries].join("\n") }} />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <main className="wrap signed-out">
      <div className="label">{notFound ? "Not found" : "Error"}</div>
      <h1>{notFound ? "There is nothing here." : "Something went wrong."}</h1>
      <p className="actions"><a href="/">Back to the service index</a></p>
    </main>
  );
}
