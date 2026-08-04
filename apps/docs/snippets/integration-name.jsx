export function IntegrationName({ href, icon, name }) {
  const manualIcons = {
    daytona: '/logo/integrations/daytona.svg',
    e2b: '/logo/integrations/e2b.svg',
    blaxel: '/logo/integrations/blaxel.svg',
    azure: '/logo/integrations/azure.svg',
    granola: '/logo/integrations/granola.svg',
    monday: '/logo/integrations/monday.svg',
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
