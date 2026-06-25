import { demoOperationalBanner } from "@/components/demo-data";
import { PublicSiteFooter } from "@/components/public-site-footer";
import { PublicSiteHeader } from "@/components/public-site-header";

export function SiteShell({
  children,
  compact = false,
  headerVariant = "default",
}: {
  children: React.ReactNode;
  compact?: boolean;
  headerVariant?: "default" | "panel";
}) {
  return (
    <div className="demo-shell">
      <div className="demo-backdrop" aria-hidden="true" />
      <PublicSiteHeader variant={headerVariant} />
      <main className="demo-shell-inner">
        {compact ? null : <div className="demo-banner">{demoOperationalBanner}</div>}
        <div className="demo-main">{children}</div>
      </main>
      {headerVariant === "panel" ? null : <PublicSiteFooter />}
    </div>
  );
}
