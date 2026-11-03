// Verified business metrics: one number with its definition attached, computed by paging
// through every matching row, so Claude does not hand-sum insyte_query pages.

import { z } from "zod";
import { METRICS, findMetric } from "../metrics/definitions.js";
import { runMetric } from "../metrics/engine.js";
import { ToolModule, json, readOnly, run, systemShape } from "../server.js";

const ids = METRICS.map((m) => m.id) as [string, ...string[]];

export const metricsModule: ToolModule = {
  name: "metrics",
  profiles: ["public", "support"],
  instructions:
    "For revenue, service job, jobs-by-stage and won-opportunity questions, call insyte_metric instead of adding up insyte_query rows yourself. It pages to the end, returns one number with its definition, date field and caveats, and refuses when it cannot be sure. State the definition it used when you give the number, and call insyte_list_metrics when the user's wording could mean more than one metric.",
  register(server, { conns }) {
    server.registerTool(
      "insyte_list_metrics",
      {
        title: "List Insyte metrics",
        description: "List the verified metrics insyte_metric can compute, with each one's definition, date field and caveats. Makes no calls to Insyte.",
        annotations: readOnly,
      },
      async () =>
        run(() =>
          json({
            metrics: METRICS.map((m) => ({
              id: m.id,
              title: m.title,
              definition: m.definition,
              dateField: m.dateField,
              unit: m.unit,
              groupBy: m.groupings,
              caveats: m.caveats,
            })),
          }),
        ),
    );

    server.registerTool(
      "insyte_metric",
      {
        title: "Compute an Insyte metric",
        description:
          "Compute one verified metric (revenue, service jobs, jobs by stage, won opportunities) for a date range. Pages through all matching records, one request at a time, and returns the value with its definition and caveats. Refuses, with a hint, if the range is too large to scan fully. Call insyte_list_metrics first if unsure which metric fits.",
        inputSchema: {
          metric: z.enum(ids).describe("Metric id from insyte_list_metrics."),
          from: z.string().describe("First day, inclusive, as YYYY-MM-DD."),
          to: z.string().describe("Last day, inclusive, as YYYY-MM-DD."),
          groupBy: z.enum(["none", "month", "rep"]).default("none").describe("Split the value by month or by rep (shown as an Insyte user ID). Not every metric supports every split."),
          ...systemShape(conns),
        },
        annotations: readOnly,
      },
      async ({ metric, from, to, groupBy, system }) =>
        run(async () => {
          const def = findMetric(metric);
          const { name, client } = await conns.connect(system);
          const orderby = client.dataSet(def.dataset).key[0] ?? "ID";
          // Sequential on purpose: Accent's acceptable use policy rules out parallel bursts.
          const result = await runMetric(def, { from, to }, groupBy, orderby, (req) =>
            client.query(def.dataset, { select: req.select, filter: req.filter, expand: req.expand, orderby: req.orderby, limit: req.limit, skip: req.skip, count: req.count }),
          );
          const { metric: id, ...rest } = result;
          return json({ ...(conns.multi ? { system: name } : {}), metric: id, ...rest });
        }),
    );
  },
};
