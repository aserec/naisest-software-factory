import { RunnerView } from "@/components/runner-view";
import { PageTitle } from "@/components/shell";

export default function RunnerPage() {
  return (
    <main>
      <PageTitle title="Runner">CI jobs, disk and memory, and logs of the factory&apos;s runner hosts.</PageTitle>
      <RunnerView />
    </main>
  );
}
