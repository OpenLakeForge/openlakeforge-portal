import type { ReactNode } from "react";

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

function Header({ signOut }: { signOut?: string }) {
  return (
    <header className="site-header">
      <div className="wrap">
        <Mark />
        <span className="wordmark">Open<span>Lake</span>Forge</span>
        <span className="label pill">Platform portal</span>
        {signOut && <a className="sign-out label" href={signOut}>Sign out</a>}
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <div className="wrap">
        <svg viewBox="0 0 1440 120" preserveAspectRatio="none" aria-hidden="true">
          <g fill="none" stroke="currentColor" strokeLinecap="round">
            <path strokeWidth="1.5" opacity=".6" d="M0 40C240 70 480 82 720 82S1200 70 1440 40" />
            <path strokeWidth="1.2" opacity=".35" d="M0 64C240 92 480 104 720 104S1200 92 1440 64" />
            <path strokeWidth="1" opacity=".18" d="M0 86C240 110 480 118 720 118S1200 110 1440 86" />
          </g>
        </svg>
        <p className="label">OpenLakeForge &middot; rendered from the access contract</p>
      </div>
    </footer>
  );
}

export function Page({ signOut, children }: { signOut?: string; children: ReactNode }) {
  return (
    <>
      <Header signOut={signOut} />
      {children}
      <Footer />
    </>
  );
}
