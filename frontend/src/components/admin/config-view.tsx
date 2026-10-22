import { EyeOff } from "lucide-react";
import type { ConfigGroup } from "@/lib/admin";
import { Panel } from "./common";

/** Read-only effective configuration. Secret-shaped keys/values are replaced with "Hidden" even if the API ever returned them. */
export function ConfigView({ groups }: { groups: ConfigGroup[] }) {
  return (
    <div className="space-y-6">
      <p className="flex items-start gap-2 rounded-xl border bg-muted/40 px-4 py-3 text-sm" data-testid="config-note">
        <EyeOff className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span>Secret values — API keys, encryption keys, tokens, passwords and connection strings — are never displayed or returned. This page is read-only; settings are changed through the deployment&apos;s environment.</span>
      </p>
      {groups.length === 0 && <p className="text-sm text-muted-foreground">No configuration was returned.</p>}
      {groups.map((g, i) => (
        <Panel key={g.group} id={`cfg-${i}`} title={g.group}>
          <dl className="divide-y" data-testid="config-group">
            {g.entries.map((e) => (
              <div key={e.key} className="grid gap-1 px-5 py-2.5 text-sm sm:grid-cols-[16rem_1fr] sm:gap-4">
                <dt className="break-words font-mono text-xs text-muted-foreground">{e.key}</dt>
                <dd className="break-words">{e.hidden ? <span className="inline-flex items-center gap-1 text-muted-foreground"><EyeOff className="size-3.5" aria-hidden /> Hidden</span> : e.value}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      ))}
    </div>
  );
}
