import { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, webhookId } = await authenticate.webhook(request);

  // Verify this is a valid order creation webhook
  if (topic !== "orders/create") {
    return new Response(`Webhook topic ${topic} not supported`, { status: 400 });
  }

  try {
    const order = await request.json();
    
    // Only process orders with customers
    if (!order.customer || !order.customer.id) {
      return new Response("No customer associated with this order", { status: 200 });
    }

    // Calculate points (1 point per $10 spent)
    const subtotal = parseFloat(order.subtotal_price || "0");
    const points = Math.floor(subtotal / 10);
    
    if (points <= 0) {
      return new Response("No points earned (subtotal too low)", { status: 200 });
    }

    const customerId = order.customer.id;
    const orderId = order.id;
    
    // Check if we already processed this order (prevent duplicates)
    const existingOrder = await prisma.$queryRaw`
      SELECT * FROM "_prisma_migrations" 
      WHERE name = ${`order_${orderId}_processed`}
      LIMIT 1
    `;
    
    if (Array.isArray(existingOrder) && existingOrder.length > 0) {
      return new Response("Order already processed", { status: 200 });
    }
    
    // Mark this order as processed to prevent duplicate processing
    await prisma.$executeRaw`
      INSERT INTO "_prisma_migrations" (name, applied_steps_count)
      VALUES (${`order_${orderId}_processed`}, 1)
    `;

    // Add points to the customer's loyalty account
    const existingPoints = await prisma.loyaltyPoints.findUnique({
      where: { customerId },
    });

    if (existingPoints) {
      await prisma.loyaltyPoints.update({
        where: { customerId },
        data: {
          points: existingPoints.points + points,
          updatedAt: new Date(),
        },
      });
    } else {
      await prisma.loyaltyPoints.create({
        data: {
          customerId,
          points,
          updatedAt: new Date(),
        },
      });
    }

    return new Response(`Added ${points} points to customer ${customerId}`, {
      status: 200,
    });
  } catch (error) {
    console.error("Error processing order webhook:", error);
    return new Response(
      `Error processing webhook: ${error instanceof Error ? error.message : String(error)}`,
      { status: 500 }
    );
  }
}; 