export function formatName(name: string, maxLength: number = 20): string {
  if (name.length <= maxLength) {
    return name;
  }

  return name.substring(0, maxLength - 3) + '...';
}