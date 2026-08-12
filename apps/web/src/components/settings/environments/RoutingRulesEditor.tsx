'use client';

import { Plus, Trash2 } from '@/components/system';
import { Button, Input } from '@/components/system';

export function RoutingRulesEditor({
  rules,
  onChange,
}: {
  rules: string[];
  onChange: (rules: string[]) => void;
}) {
  return (
    <div className="space-y-2">
      {rules.map((rule, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            value={rule}
            placeholder="Messages sent in the hospital-bugs Slack channel belong here."
            aria-label={`Routing rule ${index + 1}`}
            onChange={(event) => {
              const next = [...rules];
              next[index] = event.target.value;
              onChange(next);
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove routing rule ${index + 1}`}
            onClick={() => onChange(rules.filter((_, i) => i !== index))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={rules.length >= 20}
        onClick={() => onChange([...rules, ''])}
      >
        <Plus />
        Add rule
      </Button>
    </div>
  );
}
