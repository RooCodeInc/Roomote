export function IntegrationName({ href, icon, name }) {
  const manualIcons = {
    'roomote-cloud': '/favicon.svg',
    daytona: '/logo/integrations/daytona.svg',
    e2b: '/logo/integrations/e2b.svg',
    blaxel: '/logo/integrations/blaxel.svg',
  };
  const iconSrc =
    manualIcons[icon] ??
    (icon?.startsWith('/')
      ? icon
      : `https://api.iconify.design/simple-icons:${icon}.svg?color=currentColor`);

  return (
    <a href={href} className="integration-name">
      <img
        src={iconSrc}
        alt=""
        aria-hidden="true"
        className="integration-logo"
      />
      <span>{name}</span>
    </a>
  );
}
