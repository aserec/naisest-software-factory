import { Board, BoardFinding } from "@/components/board";
import { PageTitle } from "@/components/shell";

export default function Home() {
  return (
    <main>
      <PageTitle title="Board">
        <BoardFinding />
      </PageTitle>
      <Board />
    </main>
  );
}
