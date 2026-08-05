import { Button } from '../primitives/button';
import { Lightbulb, type LucideIcon } from '../primitives/icons';

type HeaderCalloutProps = {
  icon: LucideIcon;
  text: string;
  action: string;
  buttonLabel: string;
};

export function HeaderCallout({
  icon: Icon,
  text,
  action,
  buttonLabel,
}: HeaderCalloutProps) {
  return (
    <div className="flex flex-wrap shrink-0 -mt-4 md:mt-3 items-center gap-2 text-sm animate-[enter-down_1s_1_2000ms_backwards]">
      <Lightbulb className="size-4 shrink-0 text-muted-foreground hidden lg:block" />
      <div>
        <span className="mr-1">{text}</span>
        <Button asChild variant="link" className="inline" size="sm">
          <a href={action} target="_blank" rel="noopener noreferrer">
            <Icon className="hidden md:inline mr-1" />
            {buttonLabel}
          </a>
        </Button>
      </div>
    </div>
  );
}
