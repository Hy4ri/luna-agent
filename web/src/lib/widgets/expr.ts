export type CompiledExpr =
  | { ok: true; fn: (x: number, p: Record<string, number>) => number }
  | { ok: false; error: string };

type Node =
  | { type: "num"; val: number }
  | { type: "var"; name: string }
  | { type: "const"; name: "pi" | "e" }
  | { type: "unary"; op: "+" | "-"; expr: Node }
  | { type: "binary"; op: "+" | "-" | "*" | "/" | "^"; left: Node; right: Node }
  | { type: "call"; name: string; args: Node[] };

type Token =
  | { type: "num"; val: number; pos: number }
  | { type: "ident"; val: string; pos: number }
  | { type: "op"; val: string; pos: number }
  | { type: "paren"; val: "(" | ")"; pos: number }
  | { type: "comma"; pos: number };

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

const MATH_FNS_1 = new Set(["sin", "cos", "tan", "sqrt", "abs", "log", "exp"]);
const MATH_FNS_2 = new Set(["min", "max"]);

export function compileExpr(src: string, params: string[]): CompiledExpr {
  if (typeof src !== "string") return { ok: false, error: "expression must be a string" };
  if (src.length > 200) return { ok: false, error: "expression too long (max 200 chars)" };

  const paramSet = new Set(params);

  // 1. Tokenize
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++;
      continue;
    }
    const pos = i;

    // Numbers: 1, 1.5, .5, 1e3
    if (
      (c >= "0" && c <= "9") ||
      (c === "." && i + 1 < src.length && src[i + 1] >= "0" && src[i + 1] <= "9")
    ) {
      let start = i;
      let hasDot = c === ".";
      i++;
      while (i < src.length) {
        const nc = src[i];
        if (nc >= "0" && nc <= "9") {
          i++;
        } else if (nc === "." && !hasDot) {
          hasDot = true;
          i++;
        } else if ((nc === "e" || nc === "E") && i + 1 < src.length) {
          const nxt = src[i + 1];
          if (nxt === "+" || nxt === "-" || (nxt >= "0" && nxt <= "9")) {
            i += 2;
            while (i < src.length && src[i] >= "0" && src[i] <= "9") i++;
            break;
          } else {
            break;
          }
        } else {
          break;
        }
      }
      const numStr = src.slice(start, i);
      const val = Number(numStr);
      if (!Number.isFinite(val)) {
        return { ok: false, error: `invalid number at position ${pos}` };
      }
      tokens.push({ type: "num", val, pos });
      continue;
    }

    // Identifiers: [a-z][a-z0-9_]*
    if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_") {
      let start = i;
      i++;
      while (i < src.length) {
        const nc = src[i];
        if (
          (nc >= "a" && nc <= "z") ||
          (nc >= "A" && nc <= "Z") ||
          (nc >= "0" && nc <= "9") ||
          nc === "_"
        ) {
          i++;
        } else {
          break;
        }
      }
      const val = src.slice(start, i);
      tokens.push({ type: "ident", val, pos });
      continue;
    }

    // Operators and punctuation
    if (c === "+" || c === "-" || c === "*" || c === "/" || c === "^") {
      tokens.push({ type: "op", val: c, pos });
      i++;
      continue;
    }
    if (c === "(" || c === ")") {
      tokens.push({ type: "paren", val: c as "(" | ")", pos });
      i++;
      continue;
    }
    if (c === ",") {
      tokens.push({ type: "comma", pos });
      i++;
      continue;
    }

    return { ok: false, error: `unexpected character "${c}" at position ${pos}` };
  }

  // 2. Parser (Recursive descent)
  let tIdx = 0;

  function peek(): Token | undefined {
    return tokens[tIdx];
  }

  function consume(): Token | undefined {
    return tokens[tIdx++];
  }

  // Grammar:
  // expr     -> addSub
  // addSub   -> multDiv (( '+' | '-' ) multDiv)*
  // multDiv  -> unary (( '*' | '/' ) unary)*
  // unary    -> ( '+' | '-' ) unary | power
  // power    -> primary ( '^' unary )?   (right associative, binds tighter than unary minus on left: -x^2 = -(x^2))
  // primary  -> num | ident [ '(' args ')' ] | '(' expr ')'
  // args     -> expr ( ',' expr )*

  let depth = 0;

  function parseExpr(): { ok: true; node: Node } | { ok: false; error: string } {
    depth++;
    if (depth > 50) {
      return { ok: false, error: "expression nesting too deep (max 50)" };
    }
    const res = parseAddSub();
    depth--;
    return res;
  }

  function parseAddSub(): { ok: true; node: Node } | { ok: false; error: string } {
    const leftRes = parseMultDiv();
    if (!leftRes.ok) return leftRes;
    let node = leftRes.node;

    while (true) {
      const p = peek();
      if (p && p.type === "op" && (p.val === "+" || p.val === "-")) {
        consume();
        const rightRes = parseMultDiv();
        if (!rightRes.ok) return rightRes;
        node = { type: "binary", op: p.val as "+" | "-", left: node, right: rightRes.node };
      } else {
        break;
      }
    }
    return { ok: true, node };
  }

  function parseMultDiv(): { ok: true; node: Node } | { ok: false; error: string } {
    const leftRes = parseUnary();
    if (!leftRes.ok) return leftRes;
    let node = leftRes.node;

    while (true) {
      const p = peek();
      if (p && p.type === "op" && (p.val === "*" || p.val === "/")) {
        consume();
        const rightRes = parseUnary();
        if (!rightRes.ok) return rightRes;
        node = { type: "binary", op: p.val as "*" | "/", left: node, right: rightRes.node };
      } else {
        break;
      }
    }
    return { ok: true, node };
  }

  function parseUnary(): { ok: true; node: Node } | { ok: false; error: string } {
    const p = peek();
    if (p && p.type === "op" && (p.val === "+" || p.val === "-")) {
      const op = p.val as "+" | "-";
      consume();
      const exprRes = parseUnary();
      if (!exprRes.ok) return exprRes;
      return { ok: true, node: { type: "unary", op, expr: exprRes.node } };
    }
    return parsePower();
  }

  function parsePower(): { ok: true; node: Node } | { ok: false; error: string } {
    const leftRes = parsePrimary();
    if (!leftRes.ok) return leftRes;
    const p = peek();
    if (p && p.type === "op" && p.val === "^") {
      consume();
      // Right associative: parse unary (which can be another power / unary sign)
      const rightRes = parseUnary();
      if (!rightRes.ok) return rightRes;
      return {
        ok: true,
        node: { type: "binary", op: "^", left: leftRes.node, right: rightRes.node },
      };
    }
    return leftRes;
  }

  function parsePrimary(): { ok: true; node: Node } | { ok: false; error: string } {
    const t = peek();
    if (!t) {
      return { ok: false, error: "unexpected end of expression" };
    }

    if (t.type === "num") {
      consume();
      return { ok: true, node: { type: "num", val: t.val } };
    }

    if (t.type === "paren" && t.val === "(") {
      consume();
      const eRes = parseExpr();
      if (!eRes.ok) return eRes;
      const nextT = consume();
      if (!nextT || nextT.type !== "paren" || nextT.val !== ")") {
        return { ok: false, error: `expected closing parenthesis at position ${nextT?.pos ?? src.length}` };
      }
      return eRes;
    }

    if (t.type === "ident") {
      consume();
      const name = t.val;
      // Check if function call
      const nextT = peek();
      if (nextT && nextT.type === "paren" && nextT.val === "(") {
        consume(); // consume '('
        const args: Node[] = [];
        const closeTok = peek();
        if (!(closeTok && closeTok.type === "paren" && closeTok.val === ")")) {
          while (true) {
            const argRes = parseExpr();
            if (!argRes.ok) return argRes;
            args.push(argRes.node);
            const sep = peek();
            if (sep && sep.type === "comma") {
              consume();
              continue;
            }
            break;
          }
        }
        const closeP = consume();
        if (!closeP || closeP.type !== "paren" || closeP.val !== ")") {
          return { ok: false, error: `expected closing parenthesis for function "${name}"` };
        }

        // Validate function name and arity
        if (MATH_FNS_1.has(name)) {
          if (args.length !== 1) {
            return { ok: false, error: `function "${name}" requires 1 argument (got ${args.length})` };
          }
        } else if (MATH_FNS_2.has(name)) {
          if (args.length !== 2) {
            return { ok: false, error: `function "${name}" requires 2 arguments (got ${args.length})` };
          }
        } else {
          return { ok: false, error: `unknown function "${name}"` };
        }

        return { ok: true, node: { type: "call", name, args } };
      }

      // Variable, constant or unknown identifier
      if (name === "x") {
        return { ok: true, node: { type: "var", name: "x" } };
      }
      if (paramSet.has(name)) {
        return { ok: true, node: { type: "var", name } };
      }
      if (name === "pi" || name === "e") {
        return { ok: true, node: { type: "const", name } };
      }

      return { ok: false, error: `unknown name "${name}" at position ${t.pos}` };
    }

    return { ok: false, error: `unexpected token at position ${t.pos}` };
  }

  const parseRes = parseExpr();
  if (!parseRes.ok) return parseRes;

  if (tIdx < tokens.length) {
    return { ok: false, error: `unexpected token at position ${tokens[tIdx]!.pos}` };
  }

  const node = parseRes.node;

  // 3. Compile AST to evaluator function
  const fn = (x: number, p: Record<string, number>): number => {
    return evalNode(node, x, p);
  };

  return { ok: true, fn };
}

function evalNode(node: Node, x: number, p: Record<string, number>): number {
  switch (node.type) {
    case "num":
      return node.val;
    case "var":
      return node.name === "x" ? x : (p[node.name] ?? NaN);
    case "const":
      return CONSTANTS[node.name];
    case "unary": {
      const v = evalNode(node.expr, x, p);
      return node.op === "-" ? -v : v;
    }
    case "binary": {
      const l = evalNode(node.left, x, p);
      const r = evalNode(node.right, x, p);
      switch (node.op) {
        case "+":
          return l + r;
        case "-":
          return l - r;
        case "*":
          return l * r;
        case "/":
          return l / r;
        case "^":
          return Math.pow(l, r);
      }
      break;
    }
    case "call": {
      const evaluatedArgs = node.args.map((a) => evalNode(a, x, p));
      switch (node.name) {
        case "sin":
          return Math.sin(evaluatedArgs[0]!);
        case "cos":
          return Math.cos(evaluatedArgs[0]!);
        case "tan":
          return Math.tan(evaluatedArgs[0]!);
        case "sqrt":
          return Math.sqrt(evaluatedArgs[0]!);
        case "abs":
          return Math.abs(evaluatedArgs[0]!);
        case "log":
          return Math.log(evaluatedArgs[0]!);
        case "exp":
          return Math.exp(evaluatedArgs[0]!);
        case "min":
          return Math.min(evaluatedArgs[0]!, evaluatedArgs[1]!);
        case "max":
          return Math.max(evaluatedArgs[0]!, evaluatedArgs[1]!);
      }
      return NaN;
    }
  }
  return NaN;
}
