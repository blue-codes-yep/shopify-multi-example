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

type ActionData = 
  | { success: false; error: string }
  | { success: true; message: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") || null;
  const searchTerm = url.searchParams.get("searchTerm") || "";
  
  // First, fetch all loyalty points from database
  const loyaltyPoints = await prisma.loyaltyPoints.findMany({
    orderBy: { updatedAt: 'desc' },
  });
  
  if (loyaltyPoints.length === 0) {
    return json({
      customers: [],
      pageInfo: { hasNextPage: false },
      searchTerm,
    });
  }
  
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

  return json({
    customers: customersWithPoints,
    pageInfo: customers.pageInfo,
    searchTerm,
  });
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
  const { customers, pageInfo, searchTerm } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const submit = useSubmit();
  
  const [searchValue, setSearchValue] = useState(searchTerm || "");
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [toastError, setToastError] = useState(false);
  
  // For manual points adjustment
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [pointsValue, setPointsValue] = useState("0");
  const [operation, setOperation] = useState("add");
  
  const { selectedResources, allResourcesSelected, handleSelectionChange } = 
    useIndexResourceState(customers.map((c: CustomerWithPoints) => c.id));
  
  const isSubmitting = navigation.state === "submitting";
  
  const handleSearch = () => {
    const searchParams = new URLSearchParams();
    if (searchValue) {
      searchParams.set("searchTerm", searchValue);
    }
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
  
  // Show toast when action completes
  if (actionData && !showToast) {
    setToastMessage(actionData.success ? actionData.message : `Error: ${actionData.error}`);
    setToastError(!actionData.success);
    setShowToast(true);
    
    // Reset form if successful
    if (actionData.success) {
      setSelectedCustomerId("");
      setPointsValue("0");
      setOperation("add");
    }
  }
  
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  };
  
  const resourceName = {
    singular: "customer",
    plural: "customers",
  };
  
  const customerOptions = [
    { label: "Select a customer", value: "" },
    ...customers.map((customer: CustomerWithPoints) => ({
      label: customer.displayName || customer.email,
      value: customer.id,
    })),
  ];
  
  const operationOptions = [
    { label: "Add points", value: "add" },
    { label: "Subtract points", value: "subtract" },
    { label: "Set points", value: "set" },
  ];
  
  const rowMarkup = customers.map((customer: CustomerWithPoints, index: number) => (
    <IndexTable.Row
      id={customer.id}
      key={customer.id}
      selected={selectedResources.includes(customer.id)}
      position={index}
    >
      <IndexTable.Cell>
        <Text as="span" variant="bodyMd" fontWeight="bold">
          {customer.displayName}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>{customer.email}</IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" variant="bodyMd" fontWeight="bold">
          {customer.points}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>{formatDate(customer.updatedAt)}</IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Frame>
      <Page title="Loyalty Points Manager">
        <TitleBar title="Loyalty Points Manager" />
        
        <Layout>
          <Layout.Section>
            <Card>
              <Box padding="400">
                <div style={{ marginBottom: "16px", display: "flex", gap: "8px" }}>
                  <div style={{ flex: 1 }}>
                    <TextField
                      label="Search customers"
                      value={searchValue}
                      onChange={setSearchValue}
                      autoComplete="off"
                      placeholder="Search by name, email..."
                      onClearButtonClick={() => setSearchValue("")}
                      clearButton
                    />
                  </div>
                  <div style={{ marginTop: "26px" }}>
                    <Button onClick={handleSearch}>Search</Button>
                  </div>
                </div>
                
                {customers.length > 0 ? (
                  <>
                    <IndexTable
                      resourceName={resourceName}
                      itemCount={customers.length}
                      selectedItemsCount={
                        allResourcesSelected ? 'All' : selectedResources.length
                      }
                      onSelectionChange={handleSelectionChange}
                      headings={[
                        { title: 'Customer' },
                        { title: 'Email' },
                        { title: 'Points' },
                        { title: 'Last Updated' },
                      ]}
                    >
                      {rowMarkup}
                    </IndexTable>
                    
                    {pageInfo.hasNextPage && (
                      <div style={{ marginTop: "16px", display: "flex", justifyContent: "center" }}>
                        <Pagination
                          hasPrevious={false}
                          onPrevious={() => {}}
                          hasNext={pageInfo.hasNextPage}
                          onNext={handleNextPage}
                        />
                      </div>
                    )}
                  </>
                ) : (
                  <Banner tone="info">
                    <p>No customers with loyalty points found. Adjust your search or add points to a customer.</p>
                  </Banner>
                )}
              </Box>
            </Card>
          </Layout.Section>
          
          <Layout.Section>
            <Card>
              <Box padding="400">
                <Text as="h2" variant="headingMd">Adjust Loyalty Points</Text>
                <div style={{ marginTop: "16px", display: "flex", gap: "16px", flexWrap: "wrap" }}>
                  <div style={{ minWidth: "250px", flex: "2" }}>
                    <Select
                      label="Customer"
                      options={customerOptions}
                      onChange={setSelectedCustomerId}
                      value={selectedCustomerId}
                    />
                  </div>
                  
                  <div style={{ minWidth: "150px", flex: "1" }}>
                    <Select
                      label="Operation"
                      options={operationOptions}
                      onChange={setOperation}
                      value={operation}
                    />
                  </div>
                  
                  <div style={{ minWidth: "100px", flex: "1" }}>
                    <TextField
                      label="Points"
                      type="number"
                      value={pointsValue}
                      onChange={setPointsValue}
                      autoComplete="off"
                      min="0"
                    />
                  </div>
                  
                  <div style={{ display: "flex", alignItems: "flex-end", paddingBottom: "2px" }}>
                    <Button 
                      variant="primary" 
                      onClick={handleAdjustPoints}
                      loading={isSubmitting}
                      disabled={isSubmitting || !selectedCustomerId || parseInt(pointsValue, 10) <= 0}
                    >
                      Update Points
                    </Button>
                  </div>
                </div>
              </Box>
            </Card>
          </Layout.Section>
        </Layout>
        
        {showToast && (
          <Toast
            content={toastMessage}
            error={toastError}
            onDismiss={() => setShowToast(false)}
            duration={4500}
          />
        )}
      </Page>
    </Frame>
  );
} 