/** Updates explicit IPv4 mappings for the old address, including comma lists and repeated keys. */
export function replaceBedrockPublicIp(text: string, previousIp: string, ip: string): string {
  const transports = [...text.matchAll(/^[ \t\uFEFF]*transport[ \t]*=[ \t]*(\w+)[ \t]*\r?$/gm)];
  if (transports.at(-1)?.[1] === 'raknet') return text;
  return text.replace(/^([ \t\uFEFF]*server-udp-ports[ \t]*=)([^\r\n]*)/gm, (_, key: string, value: string) => {
    const mappings = value.split(',').map((mapping) => {
      const match = /^([ \t]*)([\d.]+)(:\d+(?:-\d+)?:\d+(?:-\d+)?[ \t]*)$/.exec(mapping);
      return match?.[2] === previousIp ? `${match[1]}${ip}${match[3]}` : mapping;
    });
    return key + mappings.join(',');
  });
}
