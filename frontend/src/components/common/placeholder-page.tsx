import { Construction } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "./page-header";

/**
 * Honest placeholder for modules that are not built yet.
 * It deliberately has no inputs, no sample output and no fake results.
 */
export function PlaceholderPage({
  title, description, icon: Icon = Construction, part, planned,
}: {
  title: string;
  description: string;
  icon?: LucideIcon;
  part: number;
  planned: string[];
}) {
  return (
    <>
      <PageHeader title={title} description={description} actions={<Badge variant="outline" className="rounded-full">Not implemented yet</Badge>} />
      <Card className="rounded-2xl shadow-card">
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="inline-flex size-10 items-center justify-center rounded-xl bg-warning-soft text-warning"><Icon className="size-5" aria-hidden /></span>
            <div>
              <CardTitle>Coming in Part {part} of the build</CardTitle>
              <CardDescription>This page is a labelled placeholder. Nothing here is functional, and no data is simulated.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p className="mb-2 text-sm font-medium">Planned for this module</p>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            {planned.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
