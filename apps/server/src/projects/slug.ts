import { ValidationError } from '../errors.js';

const MAX_SLUG = 100;

/** "AgentSecretsManager" -> "agent-secrets-manager", "  My_App v2 " -> "my-app-v2". */
export function projectSlug(name: string): string {
  const slug = name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2') // fooBar -> foo-Bar
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2') // HTTPServer -> HTTP-Server
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '');
  if (!slug) throw new ValidationError('invalid_project');
  return slug;
}
