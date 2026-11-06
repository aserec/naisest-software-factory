import { Bot, FilePen, FileText, FolderSearch, Globe, ListTodo, type LucideIcon, Search, SquareTerminal, Wrench } from "lucide-react";
import type { EventOf } from "software-factory/run-events";
import { duration } from "@/lib/utils";

export const pre = "rounded-md bg-raised p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-words";

// An icon per kind of tool. Claude Code names tools "Read", Pi "read", so the name is matched in lower case.
const TOOL_ICON: Record<string, LucideIcon> = { bash: SquareTerminal, read: FileText, edit: FilePen, multiedit: FilePen, write: FilePen, notebookedit: FilePen, grep: Search, glob: FolderSearch, find: FolderSearch, ls: FolderSearch, webfetch: Globe, websearch: Globe, task: Bot, todowrite: ListTodo };
const ToolIcon = ({ name }: { name: string }) => {
  const Icon = TOOL_ICON[name.toLowerCase()] ?? Wrench;
  return <Icon className="size-4 flex-none self-center text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />;
};

// What a call acted on, from its JSON input: a bash command, a file, a pattern. An input cut at MAX_FIELD is no longer JSON, so it shows none.
function toolTarget(input: string): string | undefined {
  try {
    const i = JSON.parse(input) as Record<string, unknown>;
    return [i.command, i.file_path, i.path, i.pattern, i.url, i.query].find((v): v is string => typeof v === "string");
  } catch {}
}

const took = (ms: number) => (!Number.isFinite(ms) || ms < 0 ? undefined : ms < 1000 ? `${Math.round(ms)} ms` : duration(ms / 1000));

function ToolCall({ call }: { call: EventOf<"tool_call"> }) {
  const { name, input, result, ms, ok } = call.data;
  const what = toolTarget(input);
  const time = [took(ms), !ok && "failed"].filter(Boolean).join(", ");
  return (
    <details className="group">
      <summary className="flex w-full cursor-pointer list-none items-baseline gap-2 rounded-md py-1 hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ToolIcon name={name} />
        <span className="flex-none font-medium group-open:underline">{name}</span>
        {what && <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{what}</code>}
        {time && <span className={`ml-auto flex-none text-xs ${ok ? "text-muted-foreground" : "text-destructive"}`}>{time}</span>}
      </summary>
      <div className="mt-1 mb-3 flex flex-col gap-2">
        <pre className={pre}>{input}</pre>
        <pre className={pre}>{result}</pre>
      </div>
    </details>
  );
}

// From this many calls of the same tool in a row, they fold into one line, so twenty reads do not push the rest away.
const FOLD = 3;

export function ToolCalls({ tools }: { tools: EventOf<"tool_call">[] }) {
  const runs: EventOf<"tool_call">[][] = [];
  for (const t of tools) {
    const last = runs.at(-1);
    if (last?.[0].data.name === t.data.name) last.push(t);
    else runs.push([t]);
  }
  const one = (t: EventOf<"tool_call">) => (
    <li key={t.id}>
      <ToolCall call={t} />
    </li>
  );
  return (
    <ul className="flex flex-col gap-1">
      {runs.map((run) => {
        if (run.length < FOLD) return run.map(one);
        const failed = run.filter((t) => !t.data.ok).length;
        const time = [took(run.reduce((sum, t) => sum + t.data.ms, 0)), failed && `${failed} failed`].filter(Boolean).join(", ");
        return (
          <li key={run[0].id}>
            <details className="group/run">
              <summary className="flex w-full cursor-pointer list-none items-baseline gap-2 rounded-md py-1 hover:text-foreground [&::-webkit-details-marker]:hidden">
                <ToolIcon name={run[0].data.name} />
                <span className="flex-none font-medium group-open/run:underline">{run[0].data.name}</span>
                <span className="text-muted-foreground">{run.length} calls in a row</span>
                <span className={`ml-auto flex-none text-xs ${failed ? "text-destructive" : "text-muted-foreground"}`}>{time}</span>
              </summary>
              <ul className="mt-1 mb-2 flex flex-col gap-1 border-l border-rule pl-4">{run.map(one)}</ul>
            </details>
          </li>
        );
      })}
    </ul>
  );
}
