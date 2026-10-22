import { compileExpr } from "./expr";

export type Widget = ChartWidget | PlotWidget;

export interface ChartWidget {
  type: "chart";
  kind: "line" | "bar";
  title?: string;
  x: string[];
  series: {
    name: string;
    data: number[];
  }[];
  yUnit?: string;
}

export interface PlotWidget {
  type: "plot";
  title?: string;
  expr: string;
  x: [number, number];
  params: Record<
    string,
    {
      min: number;
      max: number;
      step?: number;
      value: number;
    }
  >;
}

const RESERVED_NAMES = new Set([
  "x",
  "pi",
  "e",
  "sin",
  "cos",
  "tan",
  "sqrt",
  "abs",
  "log",
  "exp",
  "min",
  "max",
]);

export function parseWidget(
  json: string
): { ok: true; widget: Widget } | { ok: false; error: string } {
  if (typeof json !== "string") {
    return { ok: false, error: "invalid json" };
  }
  if (json.length > 20000) {
    return { ok: false, error: "json too long" };
  }

  let obj: any;
  try {
    obj = JSON.parse(json);
  } catch {
    return { ok: false, error: "invalid json" };
  }

  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, error: "invalid widget format" };
  }

  const type = obj.type;
  if (type !== "chart" && type !== "plot") {
    return { ok: false, error: `unknown widget type "${type}"` };
  }

  if (type === "chart") {
    const kind = obj.kind;
    if (kind !== "line" && kind !== "bar") {
      return { ok: false, error: "chart: kind must be 'line' or 'bar'" };
    }

    if (obj.title !== undefined && typeof obj.title !== "string") {
      return { ok: false, error: "chart: title must be a string" };
    }

    const x = obj.x;
    if (!Array.isArray(x) || x.length < 1 || x.length > 500) {
      return { ok: false, error: "chart: x must be an array of 1..500 strings" };
    }
    for (let i = 0; i < x.length; i++) {
      if (typeof x[i] !== "string") {
        return { ok: false, error: `chart: x[${i}] must be a string` };
      }
    }

    const series = obj.series;
    if (!Array.isArray(series) || series.length < 1 || series.length > 8) {
      return { ok: false, error: "chart: series must be an array of 1..8 series" };
    }

    for (let s = 0; s < series.length; s++) {
      const ser = series[s];
      if (!ser || typeof ser !== "object") {
        return { ok: false, error: `chart: series[${s}] must be an object` };
      }
      if (typeof ser.name !== "string") {
        return { ok: false, error: `chart: series[${s}].name must be a string` };
      }
      const data = ser.data;
      if (!Array.isArray(data) || data.length !== x.length) {
        return {
          ok: false,
          error: `chart: series[${s}].data length must match x length (${x.length})`,
        };
      }
      for (let d = 0; d < data.length; d++) {
        if (typeof data[d] !== "number" || !Number.isFinite(data[d])) {
          return {
            ok: false,
            error: `chart: series[${s}].data[${d}] must be a finite number`,
          };
        }
      }
    }

    if (obj.yUnit !== undefined && typeof obj.yUnit !== "string") {
      return { ok: false, error: "chart: yUnit must be a string" };
    }

    return {
      ok: true,
      widget: {
        type: "chart",
        kind,
        title: obj.title,
        x,
        series,
        yUnit: obj.yUnit,
      },
    };
  }

  // Plot widget validation
  if (obj.title !== undefined && typeof obj.title !== "string") {
    return { ok: false, error: "plot: title must be a string" };
  }

  const expr = obj.expr;
  if (typeof expr !== "string" || expr.length > 200) {
    return { ok: false, error: "plot: expr must be a string of max 200 chars" };
  }

  const xRange = obj.x;
  if (
    !Array.isArray(xRange) ||
    xRange.length !== 2 ||
    typeof xRange[0] !== "number" ||
    typeof xRange[1] !== "number" ||
    !Number.isFinite(xRange[0]) ||
    !Number.isFinite(xRange[1]) ||
    xRange[0] >= xRange[1]
  ) {
    return {
      ok: false,
      error: "plot: x must be a [min, max] tuple with min < max",
    };
  }

  const params = obj.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, error: "plot: params must be an object" };
  }

  const paramKeys = Object.keys(params);
  if (paramKeys.length > 6) {
    return { ok: false, error: "plot: max 6 params allowed" };
  }

  const paramNames: string[] = [];
  for (const name of paramKeys) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      return {
        ok: false,
        error: `plot: param name "${name}" must match /^[a-z][a-z0-9_]*$/`,
      };
    }
    if (RESERVED_NAMES.has(name)) {
      return { ok: false, error: `plot: param name "${name}" is reserved` };
    }
    paramNames.push(name);

    const p = params[name];
    if (!p || typeof p !== "object") {
      return { ok: false, error: `plot: param "${name}" must be an object` };
    }
    const { min, max, step, value } = p;
    if (
      typeof min !== "number" ||
      !Number.isFinite(min) ||
      typeof max !== "number" ||
      !Number.isFinite(max) ||
      min >= max
    ) {
      return {
        ok: false,
        error: `plot: param "${name}" requires finite min < max`,
      };
    }
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < min ||
      value > max
    ) {
      return {
        ok: false,
        error: `plot: param "${name}".value must be within [min, max]`,
      };
    }
    if (step !== undefined && (typeof step !== "number" || !Number.isFinite(step) || step <= 0)) {
      return { ok: false, error: `plot: param "${name}".step must be positive` };
    }
  }

  // Verify expression compiles
  // We need compileExpr from ./expr
  // Since schema.ts might be loaded independently or alongside expr.ts, we import compileExpr dynamically or statically.
  // Let's statically import compileExpr from "./expr".
  const compiled = compileExpr(expr, paramNames);
  if (!compiled.ok) {
    return { ok: false, error: `expr: ${compiled.error}` };
  }

  return {
    ok: true,
    widget: {
      type: "plot",
      title: obj.title,
      expr,
      x: [xRange[0], xRange[1]],
      params,
    },
  };
}
