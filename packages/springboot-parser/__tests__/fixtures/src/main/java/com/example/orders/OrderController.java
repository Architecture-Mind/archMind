package com.example.orders;

import org.springframework.web.bind.annotation.*;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.transaction.annotation.Transactional;
import javax.validation.Valid;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private final OrderService orderService;
    private final PaymentService paymentService;
    private final InventoryService inventoryService;
    private final ApplicationEventPublisher eventPublisher;

    public OrderController(OrderService orderService,
                           PaymentService paymentService,
                           InventoryService inventoryService,
                           ApplicationEventPublisher eventPublisher) {
        this.orderService = orderService;
        this.paymentService = paymentService;
        this.inventoryService = inventoryService;
        this.eventPublisher = eventPublisher;
    }

    @GetMapping
    @PreAuthorize("isAuthenticated()")
    public List<OrderDTO> listOrders() {
        return orderService.findAll();
    }

    @PostMapping
    @PreAuthorize("hasRole('USER')")
    @Transactional
    public ResponseEntity<OrderDTO> createOrder(@Valid @RequestBody CreateOrderRequest request) {
        OrderDTO order = orderService.createOrder(request);
        paymentService.processPayment(request.getPaymentDetails());
        inventoryService.reserve(order.getItems());
        eventPublisher.publishEvent(new OrderCreatedEvent(order));
        return ResponseEntity.ok(order);
    }

    @DeleteMapping("/{id}")
    @PreAuthorize("hasAuthority('orders:delete')")
    @Transactional
    public void cancelOrder(@PathVariable Long id) {
        orderService.cancel(id);
    }
}
