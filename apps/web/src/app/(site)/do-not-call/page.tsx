import type { Metadata } from 'next';
import { ActionForm } from '@/components/action-form';
import { inputClass } from '@/components/ui';
import { requestDoNotCall } from './actions';

export const metadata: Metadata = {
  title: 'Do not call',
  description: 'Stop calls from every business that uses Naaradh.',
};

export default function DoNotCall() {
  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">
          Stop calls from businesses using Naaradh
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Enter your number and no business using Naaradh will call it — not for orders, not for
          offers. It takes effect immediately for new calls and everywhere within 24 hours. We do
          not tell anyone whether your number was ever called.
        </p>
      </div>
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <ActionForm action={requestDoNotCall} submit="Stop calls to this number">
          <div>
            <label htmlFor="phone" className="block text-sm font-medium text-slate-800">
              Phone number
            </label>
            <input
              id="phone"
              name="phone"
              type="tel"
              required
              autoComplete="tel"
              inputMode="tel"
              placeholder="98xxx xxxxx"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="region" className="block text-sm font-medium text-slate-800">
              Country
            </label>
            <select id="region" name="region" defaultValue="IN" className={inputClass}>
              <option value="IN">India (+91)</option>
              <option value="US">United States (+1)</option>
              <option value="GB">United Kingdom (+44)</option>
            </select>
          </div>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" name="report" className="mt-1" />
            <span>
              I also want to report an unwanted call to this number. The business that called will
              be investigated.
            </span>
          </label>
        </ActionForm>
      </div>
      <p className="text-xs text-slate-500">
        You can also email dnc@naaradh.com. To ask for your data to be deleted, see the privacy
        policy.
      </p>
    </div>
  );
}
