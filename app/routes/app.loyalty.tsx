import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  IndexTable,
  Text,
  TextField,
  Button,
  useIndexResourceState,
  Toast,
  Frame,
  Banner,
  Pagination,
  Box,
  Select,
  Tabs,
  EmptyState,
  Link,
  Modal,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

type CustomerWithPoints = {
  id: string;
  email: string;
  displayName: string;
  points: number;
  updatedAt: string;
};

type Order = {
  id: string;
  orderNumber: string;
  customer: {
    id: string;
    email: string;
    displayName: string;
  };
  fulfillmentStatus: string;
  totalPrice: string;
  createdAt: string;
  pointsEarned: number;
};

type ActionData = 
  | { success: false; error: string }
  | { success: true; message: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") || null;
  const searchTerm = url.searchParams.get("searchTerm") || "";
  const tab = url.searchParams.get("tab") || "customers";
  
  // First, fetch all loyalty points from database
  const loyaltyPoints = await prisma.loyaltyPoints.findMany({
    orderBy: { updatedAt: 'desc' },
  });
  
  // Default response structure
  let responseData = {
    customers: [] as CustomerWithPoints[],
    recentOrders: [] as Order[],
    pageInfo: { hasNextPage: false, endCursor: null },
    searchTerm,
    tab,
  };
  
  // Map customer IDs to a lookup object for quick access
  const pointsMap = loyaltyPoints.reduce((acc, curr) => {
    acc[curr.customerId] = {
      points: curr.points,
      updatedAt: curr.updatedAt.toISOString(),
    };
    return acc;
  }, {} as Record<string, { points: number, updatedAt: string }>);
  
  // Get the customer IDs as an array
  const customerIds = loyaltyPoints.map(p => p.customerId);

  if (tab === "customers") {
    // If there are no loyalty points yet, return empty customer list
    if (loyaltyPoints.length === 0) {
      return json(responseData);
    }
    
    // Create a GraphQL query to fetch customer details
    let queryString = `
      query GetCustomers($first: Int!, $after: String, $query: String) {
        customers(first: $first, after: $after, query: $query) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            email
            displayName
          }
        }
      }
    `;

    const variables = {
      first: 50,
      after: cursor,
      query: searchTerm ? searchTerm : customerIds.map(id => `id:${id.replace("gid://shopify/Customer/", "")}`).join(" OR "),
    };

    const response = await admin.graphql(queryString, { variables });
    const responseJson = await response.json();
    const { customers } = responseJson.data;

    // Combine customer data with loyalty points
    const customersWithPoints = customers.nodes
      .filter((customer: any) => pointsMap[customer.id])
      .map((customer: any) => ({
        id: customer.id,
        email: customer.email,
        displayName: customer.displayName || customer.email,
        points: pointsMap[customer.id]?.points || 0,
        updatedAt: pointsMap[customer.id]?.updatedAt || new Date().toISOString(),
      }));

    responseData.customers = customersWithPoints;
    responseData.pageInfo = customers.pageInfo;
  } else if (tab === "orders") {
    // Fetch recent fulfilled orders
    const orderQuery = `
      query GetRecentOrders($first: Int!, $after: String) {
        orders(first: $first, after: $after, sortKey: PROCESSED_AT, reverse: true, query: "fulfillment_status:fulfilled") {
          edges {
            cursor
            node {
              id
              name
              processedAt
              createdAt
              customer {
                id
                email
                displayName
              }
              displayFulfillmentStatus
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    const orderVariables = {
      first: 20,
      after: cursor,
    };

    const orderResponse = await admin.graphql(orderQuery, { variables: orderVariables });
    const orderResponseJson = await orderResponse.json();
    const { orders } = orderResponseJson.data;

    // Process orders and calculate points earned
    const processedOrders = orders.edges.map((edge: any) => {
      const order = edge.node;
      const totalPrice = parseFloat(order.totalPriceSet.shopMoney.amount);
      const pointsEarned = Math.floor(totalPrice / 10); // 1 point per $10
      
      return {
        id: order.id,
        orderNumber: order.name,
        customer: {
          id: order.customer?.id || '',
          email: order.customer?.email || 'No customer',
          displayName: order.customer?.displayName || order.customer?.email || 'No customer',
        },
        fulfillmentStatus: order.displayFulfillmentStatus,
        totalPrice: `${order.totalPriceSet.shopMoney.amount} ${order.totalPriceSet.shopMoney.currencyCode}`,
        createdAt: order.createdAt,
        pointsEarned,
      };
    });

    responseData.recentOrders = processedOrders;
    responseData.pageInfo = orders.pageInfo;
  }

  return json(responseData);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const customerId = formData.get("customerId") as string;
  const pointsChange = parseInt(formData.get("points") as string, 10);
  const operation = formData.get("operation") as string;
  
  if (!customerId || isNaN(pointsChange) || pointsChange < 0) {
    return json<ActionData>({ 
      success: false, 
      error: "Invalid customer ID or points value" 
    });
  }

  try {
    // Fetch current points if they exist
    const existingPoints = await prisma.loyaltyPoints.findUnique({
      where: { customerId },
    });

    let newPoints = pointsChange;
    
    if (existingPoints) {
      if (operation === "add") {
        newPoints = existingPoints.points + pointsChange;
      } else if (operation === "subtract") {
        newPoints = Math.max(0, existingPoints.points - pointsChange);
      } else if (operation === "set") {
        newPoints = pointsChange;
      }
      
      await prisma.loyaltyPoints.update({
        where: { customerId },
        data: { 
          points: newPoints,
          updatedAt: new Date(),
        },
      });
    } else {
      // Create new record if this is a new customer
      await prisma.loyaltyPoints.create({
        data: {
          customerId,
          points: newPoints,
          updatedAt: new Date(),
        },
      });
    }

    // Fetch customer details
    const response = await admin.graphql(`
      query GetCustomer($id: ID!) {
        customer(id: $id) {
          displayName
          email
        }
      }
    `, {
      variables: { id: customerId }
    });
    
    const responseJson = await response.json();
    const customer = responseJson.data.customer;
    
    return json<ActionData>({ 
      success: true, 
      message: `Updated points for ${customer.displayName || customer.email} to ${newPoints}` 
    });
  } catch (error) {
    return json<ActionData>({ 
      success: false, 
      error: `Failed to update points: ${error instanceof Error ? error.message : String(error)}` 
    });
  }
};

export default function LoyaltyPointsManager() {
  const { customers, recentOrders, pageInfo, searchTerm, tab } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const submit = useSubmit();
  
  const [searchValue, setSearchValue] = useState(searchTerm || "");
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [toastError, setToastError] = useState(false);
  const [selectedTab, setSelectedTab] = useState(tab);
  
  // For manual points adjustment
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [pointsValue, setPointsValue] = useState("0");
  const [operation, setOperation] = useState("add");
  
  // For viewing order details
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [showOrderModal, setShowOrderModal] = useState(false);
  
  const { selectedResources, allResourcesSelected, handleSelectionChange } = 
    useIndexResourceState(customers);
  
  const isSubmitting = navigation.state === "submitting";

  const tabs = [
    {
      id: 'customers',
      content: 'Customers',
    },
    {
      id: 'orders',
      content: 'Recent Orders',
    },
  ];
  
  const handleSearch = () => {
    const searchParams = new URLSearchParams();
    if (searchValue) {
      searchParams.set("searchTerm", searchValue);
    }
    searchParams.set("tab", selectedTab);
    submit(searchParams, { method: "get" });
  };
  
  // Handle pagination
  const handleNextPage = () => {
    const searchParams = new URLSearchParams();
    if (searchValue) {
      searchParams.set("searchTerm", searchValue);
    }
    if (pageInfo.endCursor) {
      searchParams.set("cursor", pageInfo.endCursor);
    }
    searchParams.set("tab", selectedTab);
    submit(searchParams, { method: "get" });
  };
  
  // Handle points adjustment
  const handleAdjustPoints = () => {
    if (!selectedCustomerId || isNaN(parseInt(pointsValue, 10)) || parseInt(pointsValue, 10) < 0) {
      setToastMessage("Please select a customer and enter a valid points value");
      setToastError(true);
      setShowToast(true);
      return;
    }
    
    const formData = new FormData();
    formData.append("customerId", selectedCustomerId);
    formData.append("points", pointsValue);
    formData.append("operation", operation);
    
    submit(formData, { method: "post" });
  };
  
  // Handle tab change
  const handleTabChange = (selectedTabIndex: number) => {
    const newTab = tabs[selectedTabIndex].id;
    setSelectedTab(newTab);
    
    const searchParams = new URLSearchParams();
    if (searchValue) {
      searchParams.set("searchTerm", searchValue);
    }
    searchParams.set("tab", newTab);
    submit(searchParams, { method: "get" });
  };
  
  // Show toast when action completes
  if (actionData && !showToast) {
    setToastMessage(actionData.success ? actionData.message : `Error: ${actionData.error}`);
    setToastError(!actionData.success);
    setShowToast(true);
  }
  
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString() + " " + date.toLocaleTimeString();
  };
  
  return (
    <Frame>
      <Page 
        title="Loyalty Points Manager"
        subtitle="Manage customer loyalty points and view order history"
      >
        <TitleBar title="Loyalty Points Manager" />
        
        <Layout>
          <Layout.Section>
            <Card>
              <Tabs tabs={tabs} selected={tabs.findIndex(t => t.id === selectedTab)} onSelect={handleTabChange} />
              <div style={{ padding: '16px' }}>
                {selectedTab === 'customers' && (
                  <>
                    <div style={{ marginBottom: '16px' }}>
                      <TextField
                        label="Search customers"
                        value={searchValue}
                        onChange={setSearchValue}
                        autoComplete="off"
                        placeholder="Search by name, email, or ID"
                        connectedRight={
                          <Button onClick={handleSearch} loading={isSubmitting}>
                            Search
                          </Button>
                        }
                      />
                    </div>
                    
                    {customers && customers.length > 0 ? (
                      <IndexTable
                        resourceName={{
                          singular: 'customer',
                          plural: 'customers',
                        }}
                        itemCount={customers.length}
                        selectedItemsCount={allResourcesSelected ? 'All' : selectedResources.length}
                        onSelectionChange={handleSelectionChange}
                        headings={[
                          { title: 'Customer' },
                          { title: 'Email' },
                          { title: 'Points' },
                          { title: 'Last Updated' },
                        ]}
                        selectable
                      >
                        {customers.map((customer: CustomerWithPoints, index: number) => (
                          <IndexTable.Row
                            id={customer.id}
                            key={customer.id}
                            selected={selectedResources.includes(customer.id)}
                            position={index}
                          >
                            <IndexTable.Cell>
                              <Text variant="bodyMd" fontWeight="bold" as="span">
                                {customer.displayName}
                              </Text>
                            </IndexTable.Cell>
                            <IndexTable.Cell>{customer.email}</IndexTable.Cell>
                            <IndexTable.Cell>{customer.points}</IndexTable.Cell>
                            <IndexTable.Cell>{formatDate(customer.updatedAt)}</IndexTable.Cell>
                          </IndexTable.Row>
                        ))}
                      </IndexTable>
                    ) : (
                      <EmptyState
                        heading="No customers found"
                        image=""
                      >
                        <p>No customers with loyalty points found.</p>
                      </EmptyState>
                    )}
                    
                    {pageInfo && pageInfo.hasNextPage && (
                      <div style={{ marginTop: '16px' }}>
                        <Pagination
                          hasPrevious={false}
                          onPrevious={() => {}}
                          hasNext
                          onNext={handleNextPage}
                        />
                      </div>
                    )}
                  </>
                )}

                {selectedTab === 'orders' && (
                  <>
                    <div style={{ marginBottom: '16px' }}>
                      <Banner title="Order Fulfillment and Loyalty Points">
                        <p>
                          Customers earn 1 loyalty point for every $10 spent on fulfilled orders.
                          Points are automatically awarded when an order is fulfilled.
                        </p>
                      </Banner>
                    </div>
                    
                    {recentOrders && recentOrders.length > 0 ? (
                      <IndexTable
                        resourceName={{
                          singular: 'order',
                          plural: 'orders',
                        }}
                        itemCount={recentOrders.length}
                        headings={[
                          { title: 'Order' },
                          { title: 'Customer' },
                          { title: 'Status' },
                          { title: 'Total' },
                          { title: 'Date' },
                          { title: 'Points Earned' },
                        ]}
                      >
                        {recentOrders.map((order: Order, index: number) => (
                          <IndexTable.Row
                            id={order.id}
                            key={order.id}
                            position={index}
                            onClick={() => {
                              setSelectedOrder(order);
                              setShowOrderModal(true);
                            }}
                          >
                            <IndexTable.Cell>
                              <Link monochrome removeUnderline>
                                {order.orderNumber}
                              </Link>
                            </IndexTable.Cell>
                            <IndexTable.Cell>{order.customer.displayName}</IndexTable.Cell>
                            <IndexTable.Cell>{order.fulfillmentStatus}</IndexTable.Cell>
                            <IndexTable.Cell>{order.totalPrice}</IndexTable.Cell>
                            <IndexTable.Cell>{formatDate(order.createdAt)}</IndexTable.Cell>
                            <IndexTable.Cell>{order.pointsEarned}</IndexTable.Cell>
                          </IndexTable.Row>
                        ))}
                      </IndexTable>
                    ) : (
                      <EmptyState
                        heading="No fulfilled orders found"
                        image=""
                      >
                        <p>No fulfilled orders found that would earn loyalty points.</p>
                      </EmptyState>
                    )}
                    
                    {pageInfo && pageInfo.hasNextPage && (
                      <div style={{ marginTop: '16px' }}>
                        <Pagination
                          hasPrevious={false}
                          onPrevious={() => {}}
                          hasNext
                          onNext={handleNextPage}
                        />
                      </div>
                    )}
                  </>
                )}
              </div>
            </Card>
          </Layout.Section>
          
          {selectedTab === 'customers' && (
            <Layout.Section>
              <Card>
                <div style={{ padding: '16px' }}>
                  <Text variant="headingMd" as="h3">
                    Adjust Customer Points
                  </Text>
                  
                  <div style={{ marginTop: '16px' }}>
                    <Select
                      label="Operation"
                      options={[
                        { label: 'Add points', value: 'add' },
                        { label: 'Subtract points', value: 'subtract' },
                        { label: 'Set points', value: 'set' },
                      ]}
                      value={operation}
                      onChange={setOperation}
                    />
                    
                    <div style={{ marginTop: '1rem' }}>
                      <TextField
                        label="Points"
                        type="number"
                        value={pointsValue}
                        onChange={setPointsValue}
                        min={0}
                        autoComplete="off"
                      />
                    </div>
                  </div>
                  
                  <div style={{ marginTop: '16px' }}>
                    <Button
                      onClick={handleAdjustPoints}
                      loading={isSubmitting}
                      disabled={selectedResources.length !== 1}
                    >
                      Adjust Points
                    </Button>
                    {selectedResources.length !== 1 && (
                      <div style={{ marginTop: '0.5rem' }}>
                        <Text as="span" variant="bodySm">
                          Select exactly one customer to adjust points
                        </Text>
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            </Layout.Section>
          )}
        </Layout>
        
        {showToast && (
          <Toast
            content={toastMessage}
            error={toastError}
            onDismiss={() => setShowToast(false)}
            duration={4500}
          />
        )}
        
        {showOrderModal && selectedOrder && (
          <Modal
            open={showOrderModal}
            onClose={() => {
              setShowOrderModal(false);
              setSelectedOrder(null);
            }}
            title={`Order ${selectedOrder.orderNumber}`}
            primaryAction={{
              content: 'Close',
              onAction: () => {
                setShowOrderModal(false);
                setSelectedOrder(null);
              },
            }}
          >
            <div style={{ padding: '16px' }}>
              <Layout>
                <Layout.Section>
                  <Text variant="bodyLg" as="p">
                    <strong>Customer:</strong> {selectedOrder.customer.displayName}
                  </Text>
                  <Text variant="bodyLg" as="p">
                    <strong>Email:</strong> {selectedOrder.customer.email}
                  </Text>
                  <Text variant="bodyLg" as="p">
                    <strong>Status:</strong> {selectedOrder.fulfillmentStatus}
                  </Text>
                  <Text variant="bodyLg" as="p">
                    <strong>Total:</strong> {selectedOrder.totalPrice}
                  </Text>
                  <Text variant="bodyLg" as="p">
                    <strong>Date:</strong> {formatDate(selectedOrder.createdAt)}
                  </Text>
                  <Text variant="bodyLg" as="p">
                    <strong>Points Earned:</strong> {selectedOrder.pointsEarned}
                  </Text>
                </Layout.Section>
              </Layout>
            </div>
          </Modal>
        )}
      </Page>
    </Frame>
  );
} 