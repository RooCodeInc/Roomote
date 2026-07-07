import { Metadata } from 'next';
import { CircleCheck } from '@/components/system';
import { PRODUCT_NAME } from '@roomote/types';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/system';

export const metadata: Metadata = {
  title: `Account Connected - ${PRODUCT_NAME}`,
  description: 'Your Slack account has been successfully connected.',
};

export default function Page() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CircleCheck className="text-green-500" />
          <div>Slack × {PRODUCT_NAME}</div>
        </CardTitle>
        <CardDescription>
          Tasks that you start in Slack will now be associated with your{' '}
          {PRODUCT_NAME} account.
        </CardDescription>
      </CardHeader>
      <CardContent>Return to Slack to continue with your request.</CardContent>
    </Card>
  );
}
