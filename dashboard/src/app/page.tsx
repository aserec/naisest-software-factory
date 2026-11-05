import { Board } from "@/components/board";

export default function Home() {
  return (
    <main>
      {/* The breadcrumb names the page; the heading stays for screen readers. */}
      <h1 className="sr-only">Board</h1>
      <Board />
    </main>
  );
}
