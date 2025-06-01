import { useState, useEffect, useCallback } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
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
  Spinner,
  Tooltip,
  Icon,
  Link,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

type Product = {
  id: string;
  title: string;
  variants: Array<{
    id: string;
    title: string;
    inventoryQuantity: number;
    sku: string;
    inventoryItemId?: string;
    locationId?: string;
  }>;
};

type InventoryUpdate = {
  variantId: string;
  productId: string;
  oldQty: number;
  newQty: number;
  inventoryItemId?: string;
  locationId?: string;
};

type ActionData = 
  | { success: false; error: string }
  | { success: boolean; results: any[]; errors: any[] };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") || null;
  const before = url.searchParams.get("before") || null;
  const searchTerm = url.searchParams.get("searchTerm") || "";
  
  // Query for products with inventory data
  // Build a more flexible search query that finds the term anywhere in product or variant names or SKUs
  let searchQuery = searchTerm;
  if (searchTerm && !searchTerm.includes(':')) {
    // Format the query to search in product title, variant title, and SKU
    searchQuery = `(title:*${searchTerm}* OR variant_title:*${searchTerm}* OR sku:*${searchTerm}*)`;
  }
  
  const productsQuery = `
    query GetProducts($first: Int, $last: Int, $after: String, $before: String, $query: String) {
      products(first: $first, last: $last, after: $after, before: $before, query: $query) {
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
        nodes {
          id
          title
          variants(first: 20) {
            nodes {
              id
              title
              inventoryQuantity
              sku
              inventoryItem {
                id
                inventoryLevels(first: 1) {
                  edges {
                    node {
                      id
                      quantities(names: ["available"]) {
                        name
                        quantity
                      }
                      location {
                        id
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  // When using 'before', we need to use 'last', not 'first'
  const variables = {
    first: before ? null : 10,
    last: before ? 10 : null,
    after: cursor,
    before: before,
    query: searchQuery,
  };

  const response = await admin.graphql(productsQuery, { variables });
  const responseJson = await response.json();
  const { products } = responseJson.data;

  return Response.json({
    products: products.nodes.map((product: any) => ({
      id: product.id,
      title: product.title,
      variants: product.variants.nodes.map((variant: any) => {
        // Get the first inventory level's location ID and other data
        const inventoryLevel = variant.inventoryItem?.inventoryLevels?.edges[0]?.node;
        const locationId = inventoryLevel?.location?.id;
        const inventoryLevelId = inventoryLevel?.id;
        return {
          id: variant.id,
          title: variant.title,
          inventoryQuantity: variant.inventoryQuantity || 0,
          sku: variant.sku || "",
          inventoryItemId: variant.inventoryItem?.id,
          locationId,
          inventoryLevelId
        };
      }),
    })),
    pageInfo: products.pageInfo,
    searchTerm,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const updates = JSON.parse(formData.get("updates") as string) as Array<InventoryUpdate & { locationId?: string }>;
  
  if (!updates || updates.length === 0) {
    return Response.json({ success: false, error: "No updates provided" });
  }

  const results: any[] = [];
  const errors: any[] = [];

  // Filter for valid updates with inventory item IDs and quantity changes
  const validUpdates = updates.filter(update => 
    update.inventoryItemId && 
    update.newQty !== update.oldQty
  );

  if (validUpdates.length > 0) {
    try {
      // Format quantities for the inventorySetQuantities mutation
      const quantities = validUpdates.map(update => {
        const item = {
          inventoryItemId: update.inventoryItemId,
          quantity: update.newQty,
          compareQuantity: update.oldQty
        };
        
        // Only add locationId if it exists
        if (update.locationId) {
          return { ...item, locationId: update.locationId };
        }
        return item;
      });

      const response = await admin.graphql(
        `mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
          inventorySetQuantities(input: $input) {
            userErrors {
              field
              message
            }
            inventoryAdjustmentGroup {
              createdAt
              changes {
                name
                delta
              }
            }
          }
        }`,
        {
          variables: {
            input: {
              reason: "correction",
              name: "available",
              quantities
            }
          },
        }
      );

      const responseJson = await response.json();
      const result = responseJson.data?.inventorySetQuantities;
      
      if (result?.userErrors && result.userErrors.length > 0) {
        errors.push(...result.userErrors);
      } else if (result?.inventoryAdjustmentGroup) {
        // Successfully updated inventory
        results.push(...(result.inventoryAdjustmentGroup.changes || []));
        
        // Log inventory changes in database
        for (const update of validUpdates) {
          await prisma.inventoryLog.create({
            data: {
              productId: update.productId,
              variantId: update.variantId,
              oldQty: update.oldQty,
              newQty: update.newQty,
              updatedAt: new Date(),
            },
          });
        }
      }
    } catch (error) {
      errors.push({
        message: `Failed to update inventory: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return Response.json({
    success: errors.length === 0,
    results,
    errors,
  });
};

export default function InventoryManager() {
  const { products, pageInfo, searchTerm } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const submit = useSubmit();
  
  const [inventoryChanges, setInventoryChanges] = useState<Record<string, number>>({});
  const [searchValue, setSearchValue] = useState(searchTerm || "");
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [toastError, setToastError] = useState(false);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  
  const { selectedResources, allResourcesSelected, handleSelectionChange } = 
    useIndexResourceState(products.flatMap((p: Product) => p.variants.map((v) => v.id)));
  
  const isSubmitting = navigation.state === "submitting";
  const isLoading = navigation.state === "loading";
  
  // Debounced search function
  const debouncedSearch = useCallback(
    debounce((value: string) => {
      setIsSearching(true);
      const searchParams = new URLSearchParams();
      if (value) {
        searchParams.set("searchTerm", value);
      }
      // Reset cursor stack when searching
      setCursorStack([]);
      submit(searchParams, { method: "get" });
    }, 500),
    []
  );
  
  // Effect to trigger search when searchValue changes
  useEffect(() => {
    debouncedSearch(searchValue);
  }, [searchValue, debouncedSearch]);
  
  // Effect to handle navigation state
  useEffect(() => {
    if (navigation.state === "idle") {
      setIsSearching(false);
    }
  }, [navigation.state]);
  
  const handleQuantityChange = (variantId: string, newValue: string) => {
    const newQty = parseInt(newValue, 10);
    if (!isNaN(newQty) && newQty >= 0) {
      setInventoryChanges({
        ...inventoryChanges,
        [variantId]: newQty,
      });
    }
  };
  
  const handleSave = () => {
    if (Object.keys(inventoryChanges).length === 0) {
      setToastMessage("No changes to save");
      setToastError(true);
      setShowToast(true);
      return;
    }
    
    const updates: Array<InventoryUpdate & { locationId?: string }> = [];
    
    products.forEach((product: any) => {
      product.variants.forEach((variant: any) => {
        if (inventoryChanges[variant.id] !== undefined && 
            inventoryChanges[variant.id] !== variant.inventoryQuantity) {
          updates.push({
            variantId: variant.id,
            productId: product.id,
            oldQty: variant.inventoryQuantity,
            newQty: inventoryChanges[variant.id],
            inventoryItemId: variant.inventoryItemId,
            locationId: variant.locationId
          });
        }
      });
    });
    
    submit({ updates: JSON.stringify(updates) }, { method: "post" });
  };
  
  const handleSearchValueChange = (value: string) => {
    setSearchValue(value);
  };
  
  const handleClearSearch = () => {
    setSearchValue("");
  };
  
  // Handle pagination
  const handleNextPage = () => {
    const searchParams = new URLSearchParams();
    if (searchValue) {
      searchParams.set("searchTerm", searchValue);
    }
    if (pageInfo.endCursor) {
      searchParams.set("cursor", pageInfo.endCursor);
      // Add current end cursor to stack when moving forward
      setCursorStack(prev => [...prev, pageInfo.endCursor]);
    }
    submit(searchParams, { method: "get" });
  };
  
  const handlePreviousPage = () => {
    const searchParams = new URLSearchParams();
    if (searchValue) {
      searchParams.set("searchTerm", searchValue);
    }
    
    // Get the previous cursor from our stack
    if (cursorStack.length > 0) {
      // Remove the last cursor from the stack (we're going back)
      const newStack = [...cursorStack];
      newStack.pop();
      setCursorStack(newStack);
      
      // If we still have a cursor in the stack, use it as the "before" parameter
      if (newStack.length > 0) {
        searchParams.set("before", newStack[newStack.length - 1]);
      }
    }
    
    submit(searchParams, { method: "get" });
  };
  
  // Show toast when action completes
  if (actionData && !showToast) {
    if (actionData.success && 'results' in actionData) {
      // Count the actual number of updates made, not the number of results
      const updateCount = Object.keys(inventoryChanges).length;
      setToastMessage(`Successfully updated ${updateCount} variant(s) inventory quantities`);
    } else {
      setToastMessage(`Error: ${
        'error' in actionData 
          ? actionData.error 
          : actionData.errors.map((e: any) => e.message).join(", ")
      }`);
    }
    setToastError(!actionData.success);
    setShowToast(true);
    
    // Reset inventory changes if successful
    if (actionData.success) {
      setInventoryChanges({});
    }
  }
  
  const resourceName = {
    singular: "variant",
    plural: "variants",
  };
  
  const rowMarkup = products.flatMap((product: Product) => 
    product.variants.map((variant) => {
      const currentQty = inventoryChanges[variant.id] !== undefined 
        ? inventoryChanges[variant.id] 
        : variant.inventoryQuantity;
      
      const isChanged = inventoryChanges[variant.id] !== undefined && 
        inventoryChanges[variant.id] !== variant.inventoryQuantity;
        
      return (
        <IndexTable.Row
          id={variant.id}
          key={variant.id}
          selected={selectedResources.includes(variant.id)}
          position={0}
        >
          <IndexTable.Cell>
            <Text as="span" variant="bodyMd" fontWeight="bold">
              {product.title}
            </Text>
          </IndexTable.Cell>
          <IndexTable.Cell>{variant.title}</IndexTable.Cell>
          <IndexTable.Cell>{variant.sku}</IndexTable.Cell>
          <IndexTable.Cell>
            <TextField
              label="Quantity"
              labelHidden
              type="number"
              value={currentQty.toString()}
              onChange={(value) => handleQuantityChange(variant.id, value)}
              autoComplete="off"
              min={0}
              connectedRight={isChanged ? <Text as="span" variant="bodyMd" tone="caution">Changed</Text> : null}
            />
          </IndexTable.Cell>
        </IndexTable.Row>
      );
    })
  );

  return (
    <Frame>
      <Page
        title="Bulk Inventory Manager"
        primaryAction={{
          content: "Save Changes",
          onAction: handleSave,
          loading: isSubmitting,
          disabled: isSubmitting || Object.keys(inventoryChanges).length === 0,
        }}
      >
        <TitleBar title="Bulk Inventory Manager" />
        
        <Layout>
          <Layout.Section>
            <Card>
              <Box padding="400">
                <div style={{ marginBottom: "16px" }}>
                  <div style={{ marginBottom: "8px", display: "flex", alignItems: "center" }}>
                    <Text as="span" variant="bodyMd" fontWeight="semibold">Search products</Text>
                    <Tooltip content="Type any part of a product name, variant name, or SKU. We'll find matches containing your search term.">
                      <span style={{ marginLeft: "8px", display: "inline-flex" }}>
                        <Icon source="questionMarkMajor" />
                      </span>
                    </Tooltip>
                  </div>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <div style={{ flex: 1 }}>
                      <TextField
                        label="Search products"
                        labelHidden
                        value={searchValue}
                        onChange={handleSearchValueChange}
                        autoComplete="off"
                        placeholder="Search by title, SKU..."
                        onClearButtonClick={handleClearSearch}
                        clearButton
                        prefix={isSearching ? <Spinner size="small" /> : null}
                      />
                    </div>
                  </div>
                  <div style={{ marginTop: "8px" }}>
                    <Text variant="bodySm" as="p" tone="subdued">
                      For advanced filtering, try syntax like <Link url="https://shopify.dev/docs/api/admin-graphql/latest/queries/products" external monochrome>title:*jacket* OR sku:BLU-*</Link>
                    </Text>
                  </div>
                </div>
                
                {isLoading && !isSubmitting ? (
                  <div style={{ display: "flex", justifyContent: "center", padding: "2rem" }}>
                    <Spinner size="large" />
                  </div>
                ) : products.length > 0 ? (
                  <>
                    <IndexTable
                      resourceName={resourceName}
                      itemCount={products.reduce((count: number, product: Product) => count + product.variants.length, 0)}
                      selectedItemsCount={
                        allResourcesSelected ? 'All' : selectedResources.length
                      }
                      onSelectionChange={handleSelectionChange}
                      headings={[
                        { title: 'Product' },
                        { title: 'Variant' },
                        { title: 'SKU' },
                        { title: 'Inventory' },
                      ]}
                    >
                      {rowMarkup}
                    </IndexTable>
                    
                    {(pageInfo.hasNextPage || cursorStack.length > 0) && (
                      <div style={{ marginTop: "16px", display: "flex", justifyContent: "center" }}>
                        <Pagination
                          hasPrevious={cursorStack.length > 0}
                          onPrevious={handlePreviousPage}
                          hasNext={pageInfo.hasNextPage}
                          onNext={handleNextPage}
                        />
                      </div>
                    )}
                  </>
                ) : (
                  <Banner tone="info">
                    <p>No products found. Try adjusting your search.</p>
                  </Banner>
                )}
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

// Debounce helper function
function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  
  return function(...args: Parameters<T>) {
    const later = () => {
      timeout = null;
      func(...args);
    };
    
    if (timeout !== null) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(later, wait);
  };
} 