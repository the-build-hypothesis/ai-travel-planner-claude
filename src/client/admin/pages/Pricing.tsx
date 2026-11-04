import { useState, type FormEvent } from "react";
import { Pencil, Plus, Tag } from "lucide-react";
import { Alert, Badge, Button, Card, EmptyState, Input, Modal, PageLoader, Select, useToast } from "../../components/ui";
import { errorMessage } from "../../lib/api";
import { utc } from "../../lib/format";
import { useAdmin, useAdminData } from "../context";
import { PageHeader, ProviderBadge, TableWrap, Td, Th } from "../kit";

interface Rule {
  id: string;
  provider: string;
  item: string;
  description: string | null;
  input_per_mtok: number | null;
  cached_input_per_mtok: number | null;
  output_per_mtok: number | null;
  per_1000_requests: number | null;
  version: string;
  source: string | null;
  updated_at: number;
  updated_by: string | null;
}

const rate = (v: number | null, unit: string) => (v === null ? "—" : `$${v}${unit}`);

export function PricingPage() {
  const { data, error, loading, reload } = useAdminData<{ rules: Rule[]; activeModel: string | null; activeProvider: string | null }>("/api/admin/pricing");
  const [editing, setEditing] = useState<Rule | "new" | null>(null);
  if (loading && !data) return <PageLoader />;
  if (error) return <Alert title="Couldn't load pricing">{error}</Alert>;
  if (!data) return null;
  const activeKnown = data.rules.some((r) => r.provider === data.activeProvider && data.activeModel && (data.activeModel === r.item || data.activeModel.startsWith(`${r.item}-`)));
  return (
    <div>
      <PageHeader
        title="Pricing assumptions"
        description="Rates used to estimate API costs. Each usage record stores a snapshot of the rates applied, so edits only affect future requests. Changes are audit-logged."
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
            Add rule
          </Button>
        }
      />
      {data.activeModel && !activeKnown && (
        <Alert tone="amber" className="mb-4" title={`No pricing rule for the active model “${data.activeModel}”`}>
          LLM requests will be recorded with an unknown cost until a rule is added.
        </Alert>
      )}
      {data.rules.length === 0 ? (
        <EmptyState icon={<Tag className="size-6" />} title="No pricing rules" />
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th>Provider</Th>
              <Th>Model / SKU</Th>
              <Th align="right">Input / 1M</Th>
              <Th align="right">Cached input / 1M</Th>
              <Th align="right">Output / 1M</Th>
              <Th align="right">Per 1,000 req</Th>
              <Th>Version</Th>
              <Th>
                <span className="sr-only">Edit</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {data.rules.map((r) => (
              <tr key={r.id}>
                <Td>
                  <ProviderBadge provider={r.provider} />
                </Td>
                <Td>
                  <code className="text-xs">{r.item}</code>
                  {data.activeModel && (data.activeModel === r.item || data.activeModel.startsWith(`${r.item}-`)) && (
                    <Badge tone="brand" className="ml-1">
                      active
                    </Badge>
                  )}
                  {r.description && <div className="text-xs text-slate-500">{r.description}</div>}
                </Td>
                <Td align="right">{rate(r.input_per_mtok, "")}</Td>
                <Td align="right">{rate(r.cached_input_per_mtok, "")}</Td>
                <Td align="right">{rate(r.output_per_mtok, "")}</Td>
                <Td align="right">{rate(r.per_1000_requests, "")}</Td>
                <Td className="text-xs text-slate-500">
                  <code>{r.version}</code>
                  <div>
                    {utc(r.updated_at)} · {r.updated_by}
                  </div>
                </Td>
                <Td align="right">
                  <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(r)}>
                    Edit
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      <Card className="mt-4 p-4 text-xs text-slate-600">
        Source notes are shown per rule in the editor. Google Places list prices exclude monthly free usage; LLM rates are standard-tier list prices. All values USD.
      </Card>
      {editing && <RuleEditor rule={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={reload} />}
    </div>
  );
}

function RuleEditor({ rule, onClose, onSaved }: { rule: Rule | null; onClose: () => void; onSaved: () => void }) {
  const { request } = useAdmin();
  const toast = useToast();
  const [provider, setProvider] = useState(rule?.provider ?? "openai");
  const [item, setItem] = useState(rule?.item ?? "");
  const [description, setDescription] = useState(rule?.description ?? "");
  const [source, setSource] = useState(rule?.source ?? "");
  const [vals, setVals] = useState({
    input_per_mtok: rule?.input_per_mtok?.toString() ?? "",
    cached_input_per_mtok: rule?.cached_input_per_mtok?.toString() ?? "",
    output_per_mtok: rule?.output_per_mtok?.toString() ?? "",
    per_1000_requests: rule?.per_1000_requests?.toString() ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parse = (s: string) => (s.trim() === "" ? null : Number(s));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const nums = Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, parse(v)]));
    if (Object.values(nums).some((v) => v !== null && (!Number.isFinite(v) || v < 0))) return setError("Rates must be non-negative numbers.");
    const id = rule?.id ?? `${provider}:${item.trim()}`;
    setBusy(true);
    try {
      await request(`/api/admin/pricing/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: { ...(rule ? {} : { provider, item: item.trim() }), description: description || null, source: source || null, ...nums },
      });
      toast("Pricing saved");
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const isLlm = provider === "openai";
  return (
    <Modal open onClose={onClose} title={rule ? `Edit ${rule.id}` : "Add pricing rule"} size="md">
      <form onSubmit={submit} className="space-y-4">
        {!rule && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label="Provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="openai">openai (LLM)</option>
              <option value="google_places">google_places</option>
            </Select>
            <Input label={isLlm ? "Model id" : "SKU"} value={item} onChange={(e) => setItem(e.target.value)} required placeholder={isLlm ? "e.g. gpt-4.1-mini" : "e.g. text_search_pro"} />
          </div>
        )}
        <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
        {isLlm ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Input label="Input $/1M tokens" inputMode="decimal" value={vals.input_per_mtok} onChange={(e) => setVals({ ...vals, input_per_mtok: e.target.value })} />
            <Input label="Cached input $/1M" inputMode="decimal" value={vals.cached_input_per_mtok} onChange={(e) => setVals({ ...vals, cached_input_per_mtok: e.target.value })} />
            <Input label="Output $/1M tokens" inputMode="decimal" value={vals.output_per_mtok} onChange={(e) => setVals({ ...vals, output_per_mtok: e.target.value })} />
          </div>
        ) : (
          <Input label="$ per 1,000 requests" inputMode="decimal" value={vals.per_1000_requests} onChange={(e) => setVals({ ...vals, per_1000_requests: e.target.value })} />
        )}
        <Input label="Source / note" value={source} onChange={(e) => setSource(e.target.value)} hint="Where these rates come from (e.g. provider pricing page and date)." />
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Save (new version)
          </Button>
        </div>
      </form>
    </Modal>
  );
}
