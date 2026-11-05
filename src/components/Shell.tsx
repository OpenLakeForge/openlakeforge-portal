import type { ReactNode } from "react";
import { NavLink } from "react-router";

/** The OpenLakeForge mark: navy anvil (light on dark themes), azure ripples. */
function Mark() {
  return (
    <svg viewBox="280 276 730 730" width="2rem" height="2rem" aria-hidden="true">
      <path
        className="mark-anvil"
        d="M340 376H763V400H988C960 440 900 500 790 515C745 525 728 555 728 585C728 630 770 665 800 678L802 700C805 722 812 740 822 752C700 772 540 772 428 755C438 742 443 722 445 700L448 678C490 660 512 625 512 585C512 520 430 470 342 463Z"
      />
      <path fill="#12b4ff" d="M400 724A304 50 0 1 0 850 724L840 738A286 32 0 1 1 410 738Z" />
      <path fill="#12b4ff" d="M302 820A322 82 0 0 0 946 820L928 828A306 62 0 0 1 320 828Z" />
    </svg>
  );
}

export function Header({ signOut }: { signOut?: string }) {
  return (
    <header className="app-bar">
      <Mark />
      <span className="wordmark">Open<span>Lake</span>Forge</span>
      <span className="label pill">Platform</span>
      {signOut && <a className="sign-out label" href={signOut}>Sign out</a>}
    </header>
  );
}

// loading=lazy: otherwise React hoists a <link rel=preload href> per image, and
// the e2e check counts every href on the page as a route.
const items = [
  { to: "/services", label: "Services", icon: "/icons/services.svg" },
  { to: "/queries", label: "Queries", icon: "/icons/search.svg" },
];

/** The shared layout: top bar, sidebar navigation, and a slot for the page. */
export function AppShell({ signOut, children }: { signOut?: string; children: ReactNode }) {
  return (
    <div className="app">
      <Header signOut={signOut} />
      <nav className="sidebar" aria-label="Primary">
        {items.map(({ to, label, icon }) => (
          <NavLink key={to} to={to} className="nav-item">
            <img src={icon} alt="" width="16" height="16" loading="lazy" />
            {label}
          </NavLink>
        ))}
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}
