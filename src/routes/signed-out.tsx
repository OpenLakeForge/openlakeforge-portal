import { Header } from "../components/Shell";

// Where OpenLakeForge's Logout lands, outside the sign-in perimeter: the
// platform session is gone, the identity provider's own one is not.
export const meta = () => [{ title: "Signed out · OpenLakeForge" }];

export default function SignedOut() {
  return (
    <>
      <Header />
      <main className="wrap signed-out">
        <div className="label">Signed out</div>
        <h1>You are signed out of OpenLakeForge.</h1>
        <p>Your GitHub session is still active. Sign out of GitHub too on a shared browser.</p>
        <p className="actions">
          <a href="https://github.com/logout">Sign out of GitHub</a>
          <a href="/">Sign in again</a>
        </p>
      </main>
    </>
  );
}
