import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from './table';
import { Badge } from './badge';
import { Button } from './button';
import { Checkbox } from './checkbox';

const meta = {
  title: 'Foundations/Primitives/Table',
  component: Table,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Table>;

export default meta;
type Story = StoryObj<typeof meta>;

// Basic table
export const Basic: Story = {
  render: () => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Invoice</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Method</TableHead>
          <TableHead className="text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell className="font-medium">INV001</TableCell>
          <TableCell>Paid</TableCell>
          <TableCell>Credit Card</TableCell>
          <TableCell className="text-right">$250.00</TableCell>
        </TableRow>
        <TableRow>
          <TableCell className="font-medium">INV002</TableCell>
          <TableCell>Pending</TableCell>
          <TableCell>PayPal</TableCell>
          <TableCell className="text-right">$150.00</TableCell>
        </TableRow>
        <TableRow>
          <TableCell className="font-medium">INV003</TableCell>
          <TableCell>Unpaid</TableCell>
          <TableCell>Bank Transfer</TableCell>
          <TableCell className="text-right">$350.00</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
};

// With caption
export const WithCaption: Story = {
  render: () => (
    <Table>
      <TableCaption>A list of your recent invoices.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[100px]">Invoice</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Method</TableHead>
          <TableHead className="text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell className="font-medium">INV001</TableCell>
          <TableCell>Paid</TableCell>
          <TableCell>Credit Card</TableCell>
          <TableCell className="text-right">$250.00</TableCell>
        </TableRow>
        <TableRow>
          <TableCell className="font-medium">INV002</TableCell>
          <TableCell>Pending</TableCell>
          <TableCell>PayPal</TableCell>
          <TableCell className="text-right">$150.00</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
};

// With footer
export const WithFooter: Story = {
  render: () => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Invoice</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Method</TableHead>
          <TableHead className="text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell className="font-medium">INV001</TableCell>
          <TableCell>Paid</TableCell>
          <TableCell>Credit Card</TableCell>
          <TableCell className="text-right">$250.00</TableCell>
        </TableRow>
        <TableRow>
          <TableCell className="font-medium">INV002</TableCell>
          <TableCell>Pending</TableCell>
          <TableCell>PayPal</TableCell>
          <TableCell className="text-right">$150.00</TableCell>
        </TableRow>
        <TableRow>
          <TableCell className="font-medium">INV003</TableCell>
          <TableCell>Unpaid</TableCell>
          <TableCell>Bank Transfer</TableCell>
          <TableCell className="text-right">$350.00</TableCell>
        </TableRow>
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell colSpan={3}>Total</TableCell>
          <TableCell className="text-right">$750.00</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  ),
};

// Striped rows
export const StripedRows: Story = {
  render: () => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {[
          {
            name: 'John Doe',
            email: 'john@example.com',
            role: 'Admin',
            status: 'Active',
          },
          {
            name: 'Jane Smith',
            email: 'jane@example.com',
            role: 'User',
            status: 'Active',
          },
          {
            name: 'Bob Johnson',
            email: 'bob@example.com',
            role: 'User',
            status: 'Inactive',
          },
          {
            name: 'Alice Brown',
            email: 'alice@example.com',
            role: 'Moderator',
            status: 'Active',
          },
          {
            name: 'Charlie Wilson',
            email: 'charlie@example.com',
            role: 'User',
            status: 'Active',
          },
        ].map((user, index) => (
          <TableRow
            key={index}
            className={index % 2 === 0 ? 'bg-muted/50' : ''}
          >
            <TableCell className="font-medium">{user.name}</TableCell>
            <TableCell>{user.email}</TableCell>
            <TableCell>{user.role}</TableCell>
            <TableCell>{user.status}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
};

// Different cell types
export const DifferentCellTypes: Story = {
  render: () => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[50px]">Select</TableHead>
          <TableHead>Product</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Price</TableHead>
          <TableHead>Stock</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>
            <Checkbox />
          </TableCell>
          <TableCell className="font-medium">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-gray-300 rounded" />
              <span>Laptop Pro</span>
            </div>
          </TableCell>
          <TableCell>
            <Badge variant="default">Available</Badge>
          </TableCell>
          <TableCell className="font-mono">$1,299.00</TableCell>
          <TableCell>
            <div className="flex items-center gap-2">
              <div className="w-20 bg-gray-200 rounded-full h-2">
                <div className="w-3/4 bg-green-500 h-2 rounded-full" />
              </div>
              <span className="text-sm">45</span>
            </div>
          </TableCell>
          <TableCell>
            <div className="flex gap-2">
              <Button size="xs" variant="outline">
                Edit
              </Button>
              <Button size="xs" variant="destructive">
                Delete
              </Button>
            </div>
          </TableCell>
        </TableRow>
        <TableRow>
          <TableCell>
            <Checkbox />
          </TableCell>
          <TableCell className="font-medium">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-gray-300 rounded" />
              <span>Wireless Mouse</span>
            </div>
          </TableCell>
          <TableCell>
            <Badge variant="secondary">Low Stock</Badge>
          </TableCell>
          <TableCell className="font-mono">$29.99</TableCell>
          <TableCell>
            <div className="flex items-center gap-2">
              <div className="w-20 bg-gray-200 rounded-full h-2">
                <div className="w-1/4 bg-yellow-500 h-2 rounded-full" />
              </div>
              <span className="text-sm">12</span>
            </div>
          </TableCell>
          <TableCell>
            <div className="flex gap-2">
              <Button size="xs" variant="outline">
                Edit
              </Button>
              <Button size="xs" variant="destructive">
                Delete
              </Button>
            </div>
          </TableCell>
        </TableRow>
        <TableRow>
          <TableCell>
            <Checkbox />
          </TableCell>
          <TableCell className="font-medium">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-gray-300 rounded" />
              <span>USB-C Hub</span>
            </div>
          </TableCell>
          <TableCell>
            <Badge variant="destructive">Out of Stock</Badge>
          </TableCell>
          <TableCell className="font-mono">$49.99</TableCell>
          <TableCell>
            <div className="flex items-center gap-2">
              <div className="w-20 bg-gray-200 rounded-full h-2">
                <div className="w-0 bg-red-500 h-2 rounded-full" />
              </div>
              <span className="text-sm">0</span>
            </div>
          </TableCell>
          <TableCell>
            <div className="flex gap-2">
              <Button size="xs" variant="outline">
                Edit
              </Button>
              <Button size="xs" variant="destructive">
                Delete
              </Button>
            </div>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
};

// Sortable columns
export const SortableColumns: Story = {
  render: function SortableTable() {
    const [sortField, setSortField] = useState<string | null>(null);
    const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

    const data = [
      {
        id: 1,
        name: 'Alice Johnson',
        age: 28,
        department: 'Engineering',
        salary: 95000,
      },
      {
        id: 2,
        name: 'Bob Smith',
        age: 35,
        department: 'Marketing',
        salary: 75000,
      },
      {
        id: 3,
        name: 'Charlie Brown',
        age: 42,
        department: 'Sales',
        salary: 85000,
      },
      {
        id: 4,
        name: 'Diana Prince',
        age: 31,
        department: 'Engineering',
        salary: 105000,
      },
      { id: 5, name: 'Eve Adams', age: 26, department: 'HR', salary: 65000 },
    ];

    const sortedData = [...data].sort((a, b) => {
      if (!sortField) return 0;

      const aVal = a[sortField as keyof typeof a];
      const bVal = b[sortField as keyof typeof b];

      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });

    const handleSort = (field: string) => {
      if (sortField === field) {
        setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
      } else {
        setSortField(field);
        setSortDirection('asc');
      }
    };

    const SortIcon = ({ field }: { field: string }) => {
      if (sortField !== field) {
        return (
          <svg
            className="w-4 h-4 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"
            />
          </svg>
        );
      }
      return sortDirection === 'asc' ? (
        <svg
          className="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M5 15l7-7 7 7"
          />
        </svg>
      ) : (
        <svg
          className="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      );
    };

    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead
              className="cursor-pointer select-none"
              onClick={() => handleSort('name')}
            >
              <div className="flex items-center gap-1">
                Name
                <SortIcon field="name" />
              </div>
            </TableHead>
            <TableHead
              className="cursor-pointer select-none"
              onClick={() => handleSort('age')}
            >
              <div className="flex items-center gap-1">
                Age
                <SortIcon field="age" />
              </div>
            </TableHead>
            <TableHead
              className="cursor-pointer select-none"
              onClick={() => handleSort('department')}
            >
              <div className="flex items-center gap-1">
                Department
                <SortIcon field="department" />
              </div>
            </TableHead>
            <TableHead
              className="cursor-pointer select-none text-right"
              onClick={() => handleSort('salary')}
            >
              <div className="flex items-center justify-end gap-1">
                Salary
                <SortIcon field="salary" />
              </div>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedData.map((person) => (
            <TableRow key={person.id}>
              <TableCell className="font-medium">{person.name}</TableCell>
              <TableCell>{person.age}</TableCell>
              <TableCell>{person.department}</TableCell>
              <TableCell className="text-right">
                ${person.salary.toLocaleString()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  },
};

// Responsive table (horizontal scroll)
export const ResponsiveTable: Story = {
  render: () => (
    <div className="w-full">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>ID</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Phone</TableHead>
            <TableHead>Country</TableHead>
            <TableHead>Date Joined</TableHead>
            <TableHead>Last Order</TableHead>
            <TableHead>Total Spent</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[
            {
              id: 'CUS001',
              name: 'John Doe',
              email: 'john.doe@example.com',
              phone: '+1 234 567 890',
              country: 'United States',
              joined: '2023-01-15',
              lastOrder: '2024-01-10',
              spent: '$2,543.00',
              status: 'Active',
            },
            {
              id: 'CUS002',
              name: 'Jane Smith',
              email: 'jane.smith@example.com',
              phone: '+44 20 7946 0958',
              country: 'United Kingdom',
              joined: '2023-02-20',
              lastOrder: '2024-01-08',
              spent: '$1,876.50',
              status: 'Active',
            },
            {
              id: 'CUS003',
              name: 'Robert Johnson',
              email: 'robert.j@example.com',
              phone: '+61 2 9876 5432',
              country: 'Australia',
              joined: '2023-03-10',
              lastOrder: '2023-12-20',
              spent: '$987.25',
              status: 'Inactive',
            },
          ].map((customer) => (
            <TableRow key={customer.id}>
              <TableCell className="font-mono">{customer.id}</TableCell>
              <TableCell className="font-medium">{customer.name}</TableCell>
              <TableCell>{customer.email}</TableCell>
              <TableCell>{customer.phone}</TableCell>
              <TableCell>{customer.country}</TableCell>
              <TableCell>{customer.joined}</TableCell>
              <TableCell>{customer.lastOrder}</TableCell>
              <TableCell className="font-mono">{customer.spent}</TableCell>
              <TableCell>
                <Badge
                  variant={
                    customer.status === 'Active' ? 'default' : 'secondary'
                  }
                >
                  {customer.status}
                </Badge>
              </TableCell>
              <TableCell>
                <Button size="xs" variant="outline">
                  View
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  ),
};

// Selected rows
export const SelectableRows: Story = {
  render: function SelectableTable() {
    const [selectedRows, setSelectedRows] = useState<number[]>([]);

    const data = [
      { id: 1, file: 'document.pdf', size: '2.5 MB', modified: '2024-01-10' },
      { id: 2, file: 'image.png', size: '1.2 MB', modified: '2024-01-09' },
      {
        id: 3,
        file: 'spreadsheet.xlsx',
        size: '3.8 MB',
        modified: '2024-01-08',
      },
      {
        id: 4,
        file: 'presentation.pptx',
        size: '5.1 MB',
        modified: '2024-01-07',
      },
    ];

    const toggleRow = (id: number) => {
      setSelectedRows((prev) =>
        prev.includes(id)
          ? prev.filter((rowId) => rowId !== id)
          : [...prev, id],
      );
    };

    const toggleAll = () => {
      setSelectedRows((prev) =>
        prev.length === data.length ? [] : data.map((d) => d.id),
      );
    };

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {selectedRows.length} of {data.length} row(s) selected
          </p>
          {selectedRows.length > 0 && (
            <Button size="sm" variant="destructive">
              Delete Selected
            </Button>
          )}
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[50px]">
                <Checkbox
                  checked={selectedRows.length === data.length}
                  onCheckedChange={toggleAll}
                />
              </TableHead>
              <TableHead>File Name</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Modified</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((item) => (
              <TableRow
                key={item.id}
                data-state={
                  selectedRows.includes(item.id) ? 'selected' : undefined
                }
              >
                <TableCell>
                  <Checkbox
                    checked={selectedRows.includes(item.id)}
                    onCheckedChange={() => toggleRow(item.id)}
                  />
                </TableCell>
                <TableCell className="font-medium">{item.file}</TableCell>
                <TableCell>{item.size}</TableCell>
                <TableCell>{item.modified}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  },
};

// Empty state
export const EmptyState: Story = {
  render: () => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Role</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell
            colSpan={3}
            className="text-center h-24 text-muted-foreground"
          >
            No data available
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
};
