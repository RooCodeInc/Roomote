'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@/components/system';
import { useTRPC } from '@/trpc/client';

export type LoadedJudgmentExample = {
  label: string;
  expected: string;
  threshold: number;
  stage: string;
  stateText: string;
  questionsText: string;
};

export function JudgmentExamplePresets({
  onLoad,
}: {
  onLoad: (example: LoadedJudgmentExample) => void;
}) {
  const trpc = useTRPC();
  const query = useQuery(
    trpc.taskModels.judgment.examplePresets.queryOptions(),
  );
  const [ruleId, setRuleId] = useState<string>();
  const [exampleName, setExampleName] = useState<string>();
  const [packetIndex, setPacketIndex] = useState(0);
  const data = query.data;
  if (query.isPending) return <Skeleton className="h-40 w-full" />;
  if (!data)
    return (
      <div className="space-y-2">
        <p className="text-sm text-destructive">Could not load examples.</p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  const rules = [
    ...new Map(
      data.examples.map((example) => [example.ruleId, example.rule]),
    ).entries(),
  ];
  const selectedRule = ruleId ?? rules[0]?.[0];
  const examples = data.examples.filter(
    (example) => example.ruleId === selectedRule,
  );
  const example =
    examples.find((item) => item.name === exampleName) ?? examples[0];
  const packet = example?.packets[packetIndex] ?? example?.packets[0];
  if (!example || !packet)
    return (
      <p className="text-sm text-muted-foreground">No examples available.</p>
    );
  const load = () =>
    onLoad({
      label: `${example.ruleId} · ${example.name}`,
      expected: example.expected,
      threshold: example.threshold,
      stage: packet.stage,
      stateText: JSON.stringify(packet.state, null, 2),
      questionsText: JSON.stringify(
        data.questionSets[packet.questionSet]!,
        null,
        2,
      ),
    });
  return (
    <div className="space-y-3 border-y py-3">
      <div className="space-y-1.5">
        <Label htmlFor="judgment-rule">Rule</Label>
        <Select
          value={selectedRule}
          onValueChange={(value) => {
            setRuleId(value);
            setExampleName(undefined);
            setPacketIndex(0);
          }}
        >
          <SelectTrigger id="judgment-rule" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {rules.map(([id, rule]) => (
              <SelectItem key={id} value={id}>
                {id} · {rule.slice(0, 80)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{example.rule}</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="judgment-example">Example</Label>
        <Select
          value={example.name}
          onValueChange={(value) => {
            setExampleName(value);
            setPacketIndex(0);
          }}
        >
          <SelectTrigger id="judgment-example" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {examples.map((item) => (
              <SelectItem key={item.name} value={item.name}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="judgment-packet">Evidence</Label>
        <Select
          value={String(packetIndex)}
          onValueChange={(value) => setPacketIndex(Number(value))}
        >
          <SelectTrigger id="judgment-packet" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {example.packets.map((item, index) => (
              <SelectItem key={index} value={String(index)}>
                {index + 1} · {item.stage}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">
        Expected: {example.expected} · Violation cutoff:{' '}
        {Math.round(example.threshold * 100)}%. Labels stay outside model input.
      </p>
      <Button variant="outline" onClick={load}>
        Load example
      </Button>
      <p className="text-xs text-muted-foreground">
        Each request tests one evidence packet. Partial screens cannot approve a
        file. This tester allows 20 seconds per request; the commit hook has a
        three-second budget. Flag a violation when its probability meets the
        cutoff. Lower scores produce no finding, including uncertain scores near
        50%.
      </p>
    </div>
  );
}
