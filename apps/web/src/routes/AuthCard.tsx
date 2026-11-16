import { KeyRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { ThemeMenu } from '../layout/Topbar';

/** Centered single-card layout for setup and login (consent-page style from the mockups). */
export function AuthCard({ title, lede, children, footer }: { title: string; lede: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="consent-page">
      <div className="consent-corner">
        <ThemeMenu />
      </div>
      <main className="consent">
        <div className="consent-head">
          <div className="pair">
            <span className="mark mark-asm" aria-hidden="true">
              <KeyRound className="icon" strokeWidth={1.5} />
            </span>
          </div>
          <h1>{title}</h1>
          <p>{lede}</p>
        </div>
        {children}
      </main>
      {footer ? <p className="consent-note">{footer}</p> : null}
    </div>
  );
}
