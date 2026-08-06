// "12+8+5" 같은 사칙연산 식을 안전하게 계산한다. eval 사용 금지 조건이라
// 토큰화 -> 재귀하강 파서 -> 계산까지 직접 구현한다.

type TokenType = "num" | "op" | "lparen" | "rparen";
interface Token {
  type: TokenType;
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      let num = ch;
      i++;
      while (i < input.length && /[0-9.]/.test(input[i])) {
        num += input[i];
        i++;
      }
      tokens.push({ type: "num", value: num });
      continue;
    }
    if ("+-*/".includes(ch)) {
      tokens.push({ type: "op", value: ch });
      i++;
      continue;
    }
    if (ch === "(") { tokens.push({ type: "lparen", value: ch }); i++; continue; }
    if (ch === ")") { tokens.push({ type: "rparen", value: ch }); i++; continue; }
    throw new Error(`허용되지 않은 문자: ${ch}`);
  }
  return tokens;
}

// 재귀하강: expr = term (('+'|'-') term)*  /  term = factor (('*'|'/') factor)*  /  factor = number | '(' expr ')' | '-' factor
class Parser {
  tokens: Token[];
  pos = 0;
  constructor(tokens: Token[]) { this.tokens = tokens; }

  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }

  parseExpr(): number {
    let value = this.parseTerm();
    while (this.peek() && this.peek().type === "op" && (this.peek().value === "+" || this.peek().value === "-")) {
      const op = this.next().value;
      const rhs = this.parseTerm();
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  }

  parseTerm(): number {
    let value = this.parseFactor();
    while (this.peek() && this.peek().type === "op" && (this.peek().value === "*" || this.peek().value === "/")) {
      const op = this.next().value;
      const rhs = this.parseFactor();
      value = op === "*" ? value * rhs : value / rhs;
    }
    return value;
  }

  parseFactor(): number {
    const tok = this.peek();
    if (!tok) throw new Error("식이 불완전합니다");
    if (tok.type === "op" && tok.value === "-") {
      this.next();
      return -this.parseFactor();
    }
    if (tok.type === "num") {
      this.next();
      return Number(tok.value);
    }
    if (tok.type === "lparen") {
      this.next();
      const value = this.parseExpr();
      const close = this.next();
      if (!close || close.type !== "rparen") throw new Error("괄호가 맞지 않습니다");
      return value;
    }
    throw new Error("올바르지 않은 식입니다");
  }
}

/** "12+8+5" -> 25. 파싱 실패하면 null 반환 (호출부에서 원본 문자열을 그대로 쓰거나 에러 표시) */
export function evalScoreExpression(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  // 순수 숫자면 파싱할 필요도 없다
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  try {
    const tokens = tokenize(trimmed);
    if (tokens.length === 0) return null;
    const parser = new Parser(tokens);
    const result = parser.parseExpr();
    if (parser.pos !== tokens.length) return null; // 토큰이 남으면 식이 이상한 것
    return Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}
