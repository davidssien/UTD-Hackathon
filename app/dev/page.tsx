import type { Metadata } from 'next';
import DevHarness from './DevHarness';

export const metadata: Metadata = {
  title: 'Egress /dev — backend test page',
  description: 'Plain test UI for the Egress backend lane. Replaced by the ExitCraft UI at merge.',
};

export default function DevPage() {
  return <DevHarness />;
}
