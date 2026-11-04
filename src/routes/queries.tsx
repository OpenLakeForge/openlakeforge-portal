export const meta = () => [{ title: "Queries · OpenLakeForge" }];

// The slot for the query workspace (#8); until its backend exists, say so.
export default function Queries() {
  return (
    <>
      <h1>Queries</h1>
      <p className="empty">
        <span className="label">Not available yet</span>
        The query workspace is not available in this deployment yet.
      </p>
    </>
  );
}
