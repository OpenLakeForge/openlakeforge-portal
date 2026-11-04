import type { Section, Service } from "../lib/routes.server";

// Lake-bed depth contours: one outline, scaled and turned.
const rings = [
  [0.6, 8, 0.9], [1.1, 4, 0.8], [1.7, -2, 0.7], [2.4, -7, 0.6], [3.2, -11, 0.5],
  [4.1, -14, 0.4], [5.1, -16, 0.3], [6.3, -18, 0.2], [7.6, -20, 0.15],
];
const outline = "M0-100C70-104 130-70 150-20S135 85 70 102-55 118-110 80-160-10-120-60-55-97 0-100Z";

function Hero({ routeCount }: { routeCount: number }) {
  return (
    <section className="hero">
      <svg className="contours" viewBox="0 0 1200 800" aria-hidden="true">
        <g fill="none" stroke="currentColor" transform="translate(760 360)">
          {rings.map(([scale, rotate, opacity]) => (
            <path key={scale} d={outline} transform={`scale(${scale}) rotate(${rotate})`} opacity={opacity} strokeWidth={(1.2 / scale).toFixed(3)} />
          ))}
        </g>
      </svg>
      <div className="wrap">
        <div className="label">OpenLakeForge &middot; {routeCount} routes</div>
        <h1>Your lakehouse is <em>running</em>.</h1>
        <p>Every user-facing service on this cluster, grouped by stage. Shared services first, then each stage.</p>
      </div>
    </section>
  );
}

// loading=lazy: otherwise React hoists a <link rel=preload href> per logo, and the
// e2e check counts every href on the page as a route.
function ServiceCard({ service }: { service: Service }) {
  return (
    <a className="card" href={service.url} target="_blank" rel="noopener noreferrer">
      <span className="card-head">
        {service.logo
          ? <img className="icon logo" src={service.logo} alt="" width="40" height="40" loading="lazy" />
          : <span className="icon" aria-hidden="true">{service.monogram}</span>}
        <span className="card-title">
          <strong>{service.title}</strong>
          <code>{service.host}</code>
        </span>
        <span className="arrow" aria-hidden="true">&#8599;</span>
      </span>
      {service.summary && <span className="summary">{service.summary}</span>}
    </a>
  );
}

function StageSection({ section }: { section: Section }) {
  const count = section.services.length;
  const id = `stage-${section.stage}`;
  return (
    <section className="stage" aria-labelledby={id}>
      <div className="stage-head">
        <span className="label depth">{section.depth}</span>
        <span className="tick" />
        <h2 id={id}>{section.heading}</h2>
        <span className={`label tag tag-${section.stage}`}>{section.stage}</span>
        <span className="rule" />
        <span className="label count">{count} {count === 1 ? "service" : "services"}</span>
      </div>
      <ul>
        {section.services.map((service) => <li key={service.url}><ServiceCard service={service} /></li>)}
      </ul>
    </section>
  );
}

export function Index({ routeCount, stages, problem }: { routeCount: number; stages: Section[]; problem?: string }) {
  return (
    <>
      <Hero routeCount={routeCount} />
      <main className="wrap">
        {stages.map((section) => <StageSection key={section.stage} section={section} />)}
        {stages.length === 0 && (
          <p className="empty">
            <span className="label">No routes</span>
            {problem ?? "This deployment exposes no user-facing services yet."}
          </p>
        )}
      </main>
    </>
  );
}
