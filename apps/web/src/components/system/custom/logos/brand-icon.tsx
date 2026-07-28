'use client';

import {
  siAsana,
  siBetterstack,
  siBraintrust,
  siDependabot,
  siDatadog,
  siDiscord,
  siDocker,
  siGrafana,
  siBitbucket,
  siGitea,
  siGithub,
  siGitlab,
  siIntercom,
  siJira,
  siLinear,
  siModal,
  siNotion,
  siPagerduty,
  siPosthog,
  siRailway,
  siSentry,
  siSnowflake,
  siSupabase,
  siTelegram,
  siVercel,
  type SimpleIcon,
} from 'simple-icons';

type BrandIconProps = {
  icon: string;
  name: string;
  className?: string;
};

const SIMPLE_ICONS: Record<string, SimpleIcon> = {
  asana: siAsana,
  betterstack: siBetterstack,
  braintrust: siBraintrust,
  dependabot: siDependabot,
  datadog: siDatadog,
  discord: siDiscord,
  docker: siDocker,
  grafana: siGrafana,
  bitbucket: siBitbucket,
  gitea: siGitea,
  github: siGithub,
  gitlab: siGitlab,
  intercom: siIntercom,
  jira: siJira,
  linear: siLinear,
  modal: siModal,
  notion: siNotion,
  pagerduty: siPagerduty,
  posthog: siPosthog,
  railway: siRailway,
  snowflake: siSnowflake,
  supabase: siSupabase,
  telegram: siTelegram,
  sentry: siSentry,
  vercel: siVercel,
};

function NeonIcon({
  name,
  className,
  isDecorative,
}: {
  name: string;
  className?: string;
  isDecorative: boolean;
}) {
  return (
    <svg
      viewBox="0 0 58 58"
      role={isDecorative ? undefined : 'img'}
      aria-hidden={isDecorative || undefined}
      aria-label={isDecorative ? undefined : name}
      focusable="false"
      fill="currentColor"
      className={className}
    >
      <path d="M58 0.0162365V58L35.3688 38.5587V58H0V0L58 0.0162365ZM7.10962 50.9603H28.2591V23.1112L50.8907 42.937V7.05391L7.10962 7.04147V50.9603Z" />
    </svg>
  );
}

function BlaxelIcon({
  name,
  className,
  isDecorative,
}: {
  name: string;
  className?: string;
  isDecorative: boolean;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      role={isDecorative ? undefined : 'img'}
      aria-hidden={isDecorative || undefined}
      aria-label={isDecorative ? undefined : name}
      fill="currentColor"
      className={className}
    >
      <path d="M5 3h8.2a5.2 5.2 0 0 1 3.9 8.64A5.1 5.1 0 0 1 14 21H5V3Zm4 3v4h4a2 2 0 1 0 0-4H9Zm0 7v5h4.7a2.5 2.5 0 0 0 0-5H9Z" />
    </svg>
  );
}

function SupermemoryIcon({
  name,
  className,
  isDecorative,
}: {
  name: string;
  className?: string;
  isDecorative: boolean;
}) {
  return (
    <svg
      viewBox="0 0 206 168"
      role={isDecorative ? undefined : 'img'}
      aria-hidden={isDecorative || undefined}
      aria-label={isDecorative ? undefined : name}
      focusable="false"
      fill="currentColor"
      className={className}
    >
      <path d="M205.864 66.263h-76.401V0h-24.684v71.897c0 7.636 3.021 14.97 8.391 20.373l62.383 62.777 17.454-17.564-46.076-46.365h58.948v-24.84l-.015-.015Z" />
      <path d="M12.872 30.517l46.075 46.365H0v24.84h76.4v66.264h24.685V96.089c0-7.637-3.021-14.97-8.39-20.374l-62.37-62.762-17.453 17.564Z" />
    </svg>
  );
}

function ZeroIcon({
  name,
  className,
  isDecorative,
}: {
  name: string;
  className?: string;
  isDecorative: boolean;
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      role={isDecorative ? undefined : 'img'}
      aria-hidden={isDecorative || undefined}
      aria-label={isDecorative ? undefined : name}
      focusable="false"
      fill="currentColor"
      className={className}
    >
      <path d="M16 2.5c7.456 0 13.5 6.044 13.5 13.5S23.456 29.5 16 29.5 2.5 23.456 2.5 16 8.544 2.5 16 2.5Zm0 4c-5.247 0-9.5 4.253-9.5 9.5s4.253 9.5 9.5 9.5 9.5-4.253 9.5-9.5-4.253-9.5-9.5-9.5Zm4.95 4.05-9.9 9.9a1.25 1.25 0 0 0 1.768 1.768l9.9-9.9a1.25 1.25 0 1 0-1.768-1.768Z" />
    </svg>
  );
}

function PylonIcon({
  name,
  className,
  isDecorative,
}: {
  name: string;
  className?: string;
  isDecorative: boolean;
}) {
  return (
    <svg
      viewBox="0 0 64 64"
      role={isDecorative ? undefined : 'img'}
      aria-hidden={isDecorative || undefined}
      aria-label={isDecorative ? undefined : name}
      focusable="false"
      fill="currentColor"
      className={className}
    >
      <path d="M54.6261 9.35765C48.5835 3.32114 40.5462 0 31.9958 0C23.4453 0 15.408 3.32114 9.36949 9.35326C3.32689 15.3854 0 23.4044 0 31.9403C0 40.4759 3.32689 48.495 9.36949 54.5271C15.4124 60.5592 23.4494 63.8847 32.0002 63.8847C40.5506 63.8847 48.5879 60.5636 54.6305 54.5315C60.6731 48.499 64 40.4803 64 31.9444C64 23.4088 60.6731 15.3898 54.6305 9.35765H54.6261ZM57.3165 31.9444C57.3165 44.6019 47.8791 55.3404 35.3355 56.9967V6.88362C47.8791 8.53996 57.3165 19.2828 57.3165 31.9403V31.9444ZM12.3526 16.0124C16.4647 10.9629 22.2359 7.73072 28.6604 6.88362V16.0124H12.3526ZM28.6604 22.68V28.6402H6.89579C7.16284 26.5985 7.68508 24.5946 8.44024 22.68H28.6604ZM28.6604 35.3037V41.2638H8.46559C7.70199 39.3492 7.17567 37.3454 6.90423 35.3037H28.6604ZM28.6604 47.9315V56.9967C22.2697 56.1537 16.5157 52.9427 12.408 47.9315H28.6604Z" />
    </svg>
  );
}

function MicrosoftIcon({
  name,
  className,
  isDecorative,
}: {
  name: string;
  className?: string;
  isDecorative: boolean;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      role={isDecorative ? undefined : 'img'}
      aria-hidden={isDecorative || undefined}
      aria-label={isDecorative ? undefined : name}
      focusable="false"
      fill="currentColor"
      className={className}
    >
      <path d="M3 3h8v8H3V3Zm10 0h8v8h-8V3ZM3 13h8v8H3v-8Zm10 0h8v8h-8v-8Z" />
    </svg>
  );
}

function AzureIcon({
  name,
  className,
  isDecorative,
}: {
  name: string;
  className?: string;
  isDecorative: boolean;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      role={isDecorative ? undefined : 'img'}
      aria-hidden={isDecorative || undefined}
      aria-label={isDecorative ? undefined : name}
      focusable="false"
      fill="currentColor"
      className={className}
    >
      <path d="M22.379 23.343a1.62 1.62 0 0 0 1.536-2.14v.002L17.35 1.76A1.62 1.62 0 0 0 15.816.657H8.184A1.62 1.62 0 0 0 6.65 1.76L.086 21.204a1.62 1.62 0 0 0 1.536 2.139h4.741a1.62 1.62 0 0 0 1.535-1.103l.977-2.892 4.947 3.675c.28.208.618.32.966.32m-3.084-12.531 3.624 10.739a.54.54 0 0 1-.51.713v-.001h-.03a.54.54 0 0 1-.322-.106l-9.287-6.9h4.853m6.313 7.006c.116-.326.13-.694.007-1.058L9.79 1.76a1.722 1.722 0 0 0-.007-.02h6.034a.54.54 0 0 1 .512.366l6.562 19.445a.54.54 0 0 1-.338.684" />
    </svg>
  );
}

function DaytonaIcon({
  name,
  className,
  isDecorative,
}: {
  name: string;
  className?: string;
  isDecorative: boolean;
}) {
  return (
    <svg
      viewBox="0 0 69 73"
      role={isDecorative ? undefined : 'img'}
      aria-hidden={isDecorative || undefined}
      aria-label={isDecorative ? undefined : name}
      focusable="false"
      fill="currentColor"
      className={className}
    >
      <rect
        x="3.63965"
        y="49.2356"
        width="24.9293"
        height="8.54716"
        fill="currentColor"
      />
      <rect
        x="37.1162"
        y="19.3206"
        width="28.4906"
        height="8.54716"
        fill="currentColor"
      />
      <rect
        width="29.9151"
        height="8.54717"
        transform="matrix(0.707107 -0.707106 0.707107 0.707106 22.1582 21.9543)"
        fill="currentColor"
      />
      <rect
        width="22.9746"
        height="8.54717"
        transform="matrix(-0.707107 -0.707106 -0.707107 0.707106 22.2891 43.3223)"
        fill="currentColor"
      />
      <rect
        width="24.217"
        height="8.54717"
        transform="matrix(-0.707107 0.707106 -0.707107 -0.707106 43.6572 55.2791)"
        fill="currentColor"
      />
      <rect
        width="27.066"
        height="8.54717"
        transform="matrix(0.707107 0.707106 0.707107 -0.707106 43.5264 33.9111)"
        fill="currentColor"
      />
      <rect
        x="22.1582"
        y="12.9094"
        width="20.6556"
        height="8.54718"
        transform="rotate(90 22.1582 12.9094)"
        fill="currentColor"
      />
      <rect
        x="52.0732"
        y="42.825"
        width="25.6415"
        height="8.54718"
        transform="rotate(90 52.0732 42.825)"
        fill="currentColor"
      />
    </svg>
  );
}

function E2BIcon({
  name,
  className,
  isDecorative,
}: {
  name: string;
  className?: string;
  isDecorative: boolean;
}) {
  return (
    <svg
      viewBox="0 0 192 192"
      role={isDecorative ? undefined : 'img'}
      aria-hidden={isDecorative || undefined}
      aria-label={isDecorative ? undefined : name}
      focusable="false"
      fill="currentColor"
      className={className}
    >
      <g
        transform="translate(0.000000,192.000000) scale(0.100000,-0.100000)"
        fill="currentColor"
        stroke="none"
      >
        <path
          d="M465 1474 c-45 -23 -66 -45 -86 -89 -17 -37 -19 -73 -19 -425 0 -434
        1 -439 76 -496 l37 -29 544 -3 543 -2 0 135 0 135 -438 0 c-487 0 -482 -1
        -482 64 0 17 5 37 12 44 9 9 125 12 460 12 l448 0 0 140 0 140 -448 0 c-335 0
        -451 3 -460 12 -17 17 -15 74 4 92 14 14 69 16 460 16 l444 0 0 135 0 135
        -532 0 c-464 0 -537 -2 -563 -16z"
        />
      </g>
    </svg>
  );
}

function TeamsIcon({
  name,
  className,
  isDecorative,
}: {
  name: string;
  className?: string;
  isDecorative: boolean;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      role={isDecorative ? undefined : 'img'}
      aria-hidden={isDecorative || undefined}
      aria-label={isDecorative ? undefined : name}
      focusable="false"
      fill="currentColor"
      className={className}
    >
      <path
        d="M9.186 4.797a2.42 2.42 0 1 0 -2.86 -2.448h1.178c0.929 0 1.682 0.753 1.682 1.682zm-4.295 7.738h2.613c0.929 0 1.682 -0.753 1.682 -1.682V5.58h2.783a0.7 0.7 0 0 1 0.682 0.716v4.294a4.197 4.197 0 0 1 -4.093 4.293c-1.618 -0.04 -3 -0.99 -3.667 -2.35Zm10.737 -9.372a1.674 1.674 0 1 1 -3.349 0 1.674 1.674 0 0 1 3.349 0m-2.238 9.488 -0.12 -0.002a5.2 5.2 0 0 0 0.381 -2.07V6.306a1.7 1.7 0 0 0 -0.15 -0.725h1.792c0.39 0 0.707 0.317 0.707 0.707v3.765a2.6 2.6 0 0 1 -2.598 2.598z"
        strokeWidth="1"
      />
      <path
        d="M0.682 3.349h6.822c0.377 0 0.682 0.305 0.682 0.682v6.822a0.68 0.68 0 0 1 -0.682 0.682H0.682A0.68 0.68 0 0 1 0 10.853V4.03c0 -0.377 0.305 -0.682 0.682 -0.682Zm5.206 2.596v-0.72h-3.59v0.72h1.357V9.66h0.87V5.945z"
        strokeWidth="1"
      />
    </svg>
  );
}

function SlackIcon({
  name,
  className,
  isDecorative,
}: {
  name: string;
  className?: string;
  isDecorative: boolean;
}) {
  return (
    <svg
      viewBox="4 4 24 24"
      role={isDecorative ? undefined : 'img'}
      aria-hidden={isDecorative || undefined}
      aria-label={isDecorative ? undefined : name}
      focusable="false"
      fill="currentColor"
      className={className}
    >
      <path d="M9.0423,19.1661A2.5212,2.5212,0,1,1,6.5212,16.645H9.0423Z" />
      <path d="M10.3127,19.1661a2.5212,2.5212,0,0,1,5.0423,0v6.3127a2.5212,2.5212,0,1,1-5.0423,0Z" />
      <path d="M12.8339,9.0423A2.5212,2.5212,0,1,1,15.355,6.5212V9.0423Z" />
      <path d="M12.8339,10.3127a2.5212,2.5212,0,0,1,0,5.0423H6.5212a2.5212,2.5212,0,1,1,0-5.0423Z" />
      <path d="M22.9577,12.8339a2.5212,2.5212,0,1,1,2.5211,2.5211H22.9577Z" />
      <path d="M21.6873,12.8339a2.5212,2.5212,0,0,1-5.0423,0V6.5212a2.5212,2.5212,0,1,1,5.0423,0Z" />
      <path d="M19.1661,22.9577a2.5212,2.5212,0,1,1-2.5211,2.5211V22.9577Z" />
      <path d="M19.1661,21.6873a2.5212,2.5212,0,0,1,0-5.0423h6.3127a2.5212,2.5212,0,1,1,0,5.0423Z" />
    </svg>
  );
}

/**
 * The Roomote "R" mark. The source SVG is a large traced file with hardcoded
 * fills, so it renders as a CSS mask over `bg-current` (the same technique as
 * RoomoteWordmark) to inherit the surrounding text color like every other
 * brand icon.
 */
function RoomoteIcon({
  name,
  className,
  isDecorative,
}: {
  name: string;
  className?: string;
  isDecorative: boolean;
}) {
  return (
    <span
      role={isDecorative ? undefined : 'img'}
      aria-hidden={isDecorative || undefined}
      aria-label={isDecorative ? undefined : name}
      className={`inline-block bg-current ${className ?? ''}`}
      style={{
        maskImage: 'url(/logos/r.svg)',
        maskRepeat: 'no-repeat',
        maskPosition: 'center',
        maskSize: 'contain',
        WebkitMaskImage: 'url(/logos/r.svg)',
        WebkitMaskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        WebkitMaskSize: 'contain',
      }}
    />
  );
}

export function BrandIcon({ icon, name, className }: BrandIconProps) {
  const simpleIcon = SIMPLE_ICONS[icon];
  const isDecorative = name.length === 0;

  if (icon === 'roomote') {
    return (
      <RoomoteIcon
        name={name}
        className={className}
        isDecorative={isDecorative}
      />
    );
  }

  if (icon === 'neon') {
    return (
      <NeonIcon name={name} className={className} isDecorative={isDecorative} />
    );
  }

  if (icon === 'pylon') {
    return (
      <PylonIcon
        name={name}
        className={className}
        isDecorative={isDecorative}
      />
    );
  }

  if (icon === 'supermemory') {
    return (
      <SupermemoryIcon
        name={name}
        className={className}
        isDecorative={isDecorative}
      />
    );
  }

  if (icon === 'zero') {
    return (
      <ZeroIcon name={name} className={className} isDecorative={isDecorative} />
    );
  }

  if (icon === 'teams') {
    return (
      <TeamsIcon
        name={name}
        className={className}
        isDecorative={isDecorative}
      />
    );
  }

  if (icon === 'microsoft' || icon === 'ado') {
    return (
      <MicrosoftIcon
        name={name}
        className={className}
        isDecorative={isDecorative}
      />
    );
  }

  if (icon === 'slack') {
    return (
      <SlackIcon
        name={name}
        className={className}
        isDecorative={isDecorative}
      />
    );
  }

  if (icon === 'e2b') {
    return (
      <E2BIcon name={name} className={className} isDecorative={isDecorative} />
    );
  }

  if (icon === 'blaxel') {
    return (
      <BlaxelIcon
        name={name}
        className={className}
        isDecorative={isDecorative}
      />
    );
  }

  if (icon === 'azure') {
    return (
      <AzureIcon
        name={name}
        className={className}
        isDecorative={isDecorative}
      />
    );
  }

  if (icon === 'daytona') {
    return (
      <DaytonaIcon
        name={name}
        className={className}
        isDecorative={isDecorative}
      />
    );
  }

  if (!simpleIcon) {
    return <span aria-hidden="true" className={className} />;
  }

  return (
    <svg
      viewBox="0 0 24 24"
      role={isDecorative ? undefined : 'img'}
      aria-hidden={isDecorative || undefined}
      aria-label={isDecorative ? undefined : name}
      focusable="false"
      fill="currentColor"
      className={className}
    >
      <path d={simpleIcon.path} />
    </svg>
  );
}
