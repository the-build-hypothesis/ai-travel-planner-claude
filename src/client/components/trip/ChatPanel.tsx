import { useEffect, useRef, useState } from "react";
import { ArrowUp, RotateCcw, Sparkles } from "lucide-react";
import type { ChatMessage } from "../../../shared/schemas";
import { cx } from "../ui";

const STAGES = ["Reading your request…", "Thinking about the best areas…", "Sketching each day…", "Balancing time, travel and budget…", "Checking places on the map…", "Polishing the plan…"];

const STARTERS = [
  "5 days in Tokyo with kids in April, budget $5,000",
  "A relaxed long weekend in Lisbon for two",
  "One week in Costa Rica: wildlife, beaches, some adventure",
];

function renderText(text: string) {
  // Plain text with "-" bullet support; no HTML injection (React escapes).
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) {
      out.push(
        <ul key={`l${out.length}`} className="my-1.5 list-disc space-y-0.5 pl-5">
          {list.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const m = line.match(/^\s*[-•*]\s+(.*)$/);
    if (m) {
      list.push(m[1].replace(/\*\*/g, ""));
    } else {
      flush();
      if (line.trim()) out.push(<p key={`p${out.length}`} className="my-1">{line.replace(/\*\*/g, "")}</p>);
    }
  }
  flush();
  return out;
}

export function ChatPanel({
  messages,
  sending,
  error,
  pendingText,
  onSend,
  onRetry,
  disabled,
}: {
  messages: ChatMessage[];
  sending: boolean;
  error: string | null;
  pendingText: string | null;
  onSend: (text: string) => void;
  onRetry: () => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const [stage, setStage] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, sending, error]);

  useEffect(() => {
    if (!sending) {
      setStage(0);
      return;
    }
    const t = setInterval(() => setStage((s) => Math.min(s + 1, STAGES.length - 1)), 4500);
    return () => clearInterval(t);
  }, [sending]);

  const last = [...messages].reverse().find((m) => m.role === "assistant");
  const suggestions = !sending && last?.meta?.suggestions?.length ? last.meta.suggestions : [];

  function submit(t: string) {
    const v = t.trim();
    if (!v || sending || disabled) return;
    onSend(v);
    setText("");
    inputRef.current?.focus();
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div ref={scroller} className="scrollbar-thin flex-1 space-y-4 overflow-y-auto px-4 py-5" aria-live="polite">
        {messages.length === 0 && !pendingText && (
          <div className="animate-fade-up rounded-2xl bg-gradient-to-br from-brand-50 to-cyan-50 p-5 ring-1 ring-brand-100">
            <div className="flex items-center gap-2 text-brand-800">
              <Sparkles className="size-5" />
              <p className="font-semibold">Where are we headed?</p>
            </div>
            <p className="mt-2 text-sm text-slate-600">Tell me the destination, dates or length, who's traveling, your budget and what you love. I'll ask if anything important is missing.</p>
            <div className="mt-3 flex flex-col gap-2">
              {STARTERS.map((s) => (
                <button key={s} onClick={() => submit(s)} className="rounded-xl bg-white px-3 py-2 text-left text-sm text-slate-700 ring-1 ring-slate-200 hover:ring-brand-300 hover:text-brand-800">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <Bubble key={m.id} m={m} />
        ))}
        {pendingText && <Bubble m={{ id: "pending", role: "user", content: pendingText, meta: null, createdAt: Date.now() }} />}
        {sending && (
          <div className="flex items-start gap-2.5" role="status">
            <Avatar />
            <div className="rounded-2xl rounded-tl-md bg-slate-100 px-4 py-3">
              <div className="flex items-center gap-1" aria-hidden>
                <span className="typing-dot size-1.5 rounded-full bg-brand-600" />
                <span className="typing-dot size-1.5 rounded-full bg-brand-600 [animation-delay:150ms]" />
                <span className="typing-dot size-1.5 rounded-full bg-brand-600 [animation-delay:300ms]" />
              </div>
              <p className="mt-1.5 text-xs text-slate-500">{STAGES[stage]}</p>
            </div>
          </div>
        )}
        {error && !sending && (
          <div className="animate-fade-up rounded-xl bg-red-50 p-3 text-sm text-red-800 ring-1 ring-red-200" role="alert">
            <p>{error}</p>
            {pendingText && (
              <button onClick={onRetry} className="mt-2 inline-flex items-center gap-1.5 font-semibold text-red-700 hover:text-red-900">
                <RotateCcw className="size-3.5" /> Try again
              </button>
            )}
          </div>
        )}
      </div>

      {suggestions.length > 0 && (
        <div className="scrollbar-thin flex gap-2 overflow-x-auto border-t border-slate-100 px-4 pt-3">
          {suggestions.map((s) => (
            <button
              key={s}
              onClick={() => submit(s)}
              disabled={disabled}
              className="shrink-0 rounded-full bg-brand-50 px-3 py-1.5 text-xs font-medium text-brand-800 ring-1 ring-brand-200 hover:bg-brand-100"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <form
        className="p-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit(text);
        }}
      >
        <div className="flex items-end gap-2 rounded-2xl bg-slate-50 p-1.5 ring-1 ring-slate-200 focus-within:ring-2 focus-within:ring-brand-500">
          <label htmlFor="chat-input" className="sr-only">
            Message the travel planner
          </label>
          <textarea
            id="chat-input"
            ref={inputRef}
            rows={1}
            value={text}
            maxLength={2000}
            disabled={disabled}
            onChange={(e) => {
              setText(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(text);
              }
            }}
            placeholder={messages.length ? "Ask for changes, e.g. “make day 3 less expensive”" : "Describe your trip…"}
            className="max-h-40 min-h-[40px] flex-1 resize-none border-0 bg-transparent px-2.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-0"
          />
          <button
            type="submit"
            disabled={!text.trim() || sending || disabled}
            className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-700 text-white transition hover:bg-brand-800 disabled:bg-slate-300"
            aria-label="Send message"
          >
            <ArrowUp className="size-4" />
          </button>
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-slate-400">AI suggestions can be wrong. Costs are estimates — confirm details before booking.</p>
      </form>
    </div>
  );
}

function Avatar() {
  return (
    <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-cyan-700 text-white">
      <Sparkles className="size-3.5" />
    </div>
  );
}

function Bubble({ m }: { m: ChatMessage }) {
  if (m.role === "user") {
    return (
      <div className="animate-fade-up flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-md bg-brand-700 px-4 py-2.5 text-sm text-white">{m.content}</div>
      </div>
    );
  }
  const changed = m.meta?.changedDays ?? [];
  return (
    <div className="animate-fade-up flex items-start gap-2.5">
      <Avatar />
      <div className={cx("max-w-[88%] rounded-2xl rounded-tl-md bg-slate-100 px-4 py-2.5 text-sm leading-relaxed text-slate-800")}>
        {renderText(m.content)}
        {changed.length > 0 && (
          <p className="mt-2 text-xs font-medium text-brand-700">
            ✓ Updated {changed.length > 6 ? `${changed.length} days` : `day${changed.length > 1 ? "s" : ""} ${changed.join(", ")}`}
          </p>
        )}
      </div>
    </div>
  );
}
