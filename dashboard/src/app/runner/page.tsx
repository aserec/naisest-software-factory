"use client";

import { RunnerView } from "@/components/runner-view";
import { PageTitle } from "@/components/shell";
import { useT } from "@/components/use-preferences";

export default function RunnerPage() {
  const t = useT();
  return (
    <main>
      <PageTitle title={t("Runner")}>{t("CI jobs, disk and memory, and logs of the factory's runner hosts.")}</PageTitle>
      <RunnerView />
    </main>
  );
}
