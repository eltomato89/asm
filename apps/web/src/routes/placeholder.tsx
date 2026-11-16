/** Empty state for pages delivered by later tasks (no fake data). */
export function PlaceholderPage({ title }: { title: string }) {
  return (
    <>
      <div className="page-head">
        <h1>{title}</h1>
      </div>
      <div className="empty">
        <strong>Diese Ansicht ist noch nicht verfügbar.</strong>
        Sie folgt mit dem nächsten Ausbau der Weboberfläche.
      </div>
    </>
  );
}
