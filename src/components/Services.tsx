import type { Section, Service } from "../lib/routes.server";

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
  const id = `stage-${section.stage}`;
  return (
    <section className="stage" aria-labelledby={id}>
      <h2 id={id}>{section.heading}</h2>
      <ul>
        {section.services.map((service) => <li key={service.url}><ServiceCard service={service} /></li>)}
      </ul>
    </section>
  );
}

export function Services({ stages, problem }: { stages: Section[]; problem?: string }) {
  return (
    <>
      <h1>Your lakehouse, one click away.</h1>
      <p className="lede">Open the services available in this deployment.</p>
      {stages.map((section) => <StageSection key={section.stage} section={section} />)}
      {stages.length === 0 && (
        <p className="empty">
          <span className="label">No routes</span>
          {problem ?? "This deployment exposes no user-facing services yet."}
        </p>
      )}
    </>
  );
}
