// Shown at once when a ticket opens, while the page waits on the board fetch.
export default function Loading() {
  return (
    <main role="status" aria-label="Loading the run" className="animate-pulse">
      <div className="mb-8 space-y-3">
        <div className="h-8 w-2/3 rounded bg-muted" />
        <div className="h-5 w-1/3 rounded bg-muted" />
      </div>
      <div className="space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-16 rounded-lg bg-muted" />
        ))}
      </div>
    </main>
  );
}
