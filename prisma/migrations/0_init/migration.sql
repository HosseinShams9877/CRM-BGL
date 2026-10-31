-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "BusinessUnit" (
    "id" TEXT NOT NULL DEFAULT 'production',
    "name" TEXT NOT NULL,
    "label" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "features" TEXT NOT NULL DEFAULT '{}',
    "userIds" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "BusinessUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "accentColor" TEXT NOT NULL,
    "logo" TEXT,
    "tagline" TEXT,
    "nationalId" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "postalCode" TEXT,
    "headOfficeAddress" TEXT,
    "factoryAddress" TEXT,
    "bankName" TEXT,
    "bankAccountHolder" TEXT,
    "bankAccountNumber" TEXT,
    "bankSheba" TEXT,
    "proformaNote" TEXT,
    "printTemplate" TEXT,
    "website" TEXT,
    "isIsolated" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsLog" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "messageId" TEXT,
    "error" TEXT,
    "centerName" TEXT,
    "contextType" TEXT NOT NULL DEFAULT 'manual',
    "companyId" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'standard',
    "roleLabel" TEXT NOT NULL DEFAULT 'کاربر عادی',
    "jobTitle" TEXT,
    "province" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "companyIds" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "businessUnitId" TEXT NOT NULL DEFAULT 'production',
    "companyId" TEXT,
    "territoryMode" TEXT NOT NULL DEFAULT 'country',
    "territoryProvinces" TEXT NOT NULL DEFAULT '[]',
    "territoryCenterIds" TEXT NOT NULL DEFAULT '[]',
    "territoryUpdatedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Center" (
    "id" TEXT NOT NULL,
    "businessUnitId" TEXT NOT NULL DEFAULT 'production',
    "companyId" TEXT NOT NULL DEFAULT 'bazargani',
    "name" TEXT NOT NULL,
    "customerType" TEXT NOT NULL DEFAULT 'organization',
    "segment" TEXT NOT NULL DEFAULT '',
    "mobile" TEXT,
    "loyaltyPoints" INTEGER NOT NULL DEFAULT 0,
    "creditScore" INTEGER NOT NULL DEFAULT 0,
    "paymentBehavior" TEXT NOT NULL DEFAULT 'unknown',
    "commissionPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "province" TEXT,
    "city" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "nationalId" TEXT,
    "economicCode" TEXT,
    "postalCode" TEXT,
    "contactName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "customFields" TEXT NOT NULL DEFAULT '{}',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "searchKey" TEXT,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Center_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CenterAccount" (
    "id" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "totalSales" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalPaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CenterAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CenterContact" (
    "id" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "person" TEXT,
    "phone" TEXT NOT NULL,
    "notes" TEXT,
    "isAgent" BOOLEAN NOT NULL DEFAULT false,
    "personality" TEXT NOT NULL DEFAULT '{}',
    "createdBy" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CenterContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactProfileNote" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "content" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactProfileNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "businessUnitId" TEXT NOT NULL DEFAULT 'production',
    "centerId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "activityDate" TIMESTAMP(3) NOT NULL,
    "activityTime" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "completedAt" TIMESTAMP(3),
    "isPhoneCall" BOOLEAN NOT NULL DEFAULT false,
    "isOnsiteVisit" BOOLEAN NOT NULL DEFAULT false,
    "isUnansweredCall" BOOLEAN NOT NULL DEFAULT false,
    "assignedTo" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "voiceNoteFileId" TEXT,
    "voiceTranscript" TEXT NOT NULL DEFAULT '',
    "products" TEXT NOT NULL DEFAULT '[]',

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL DEFAULT 'عدد',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'دستی',
    "category" TEXT NOT NULL DEFAULT '',
    "specs" TEXT NOT NULL DEFAULT '{}',
    "warrantyMonths" INTEGER NOT NULL DEFAULT 12,
    "ircCode" TEXT,
    "companyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesDocument" (
    "id" TEXT NOT NULL,
    "businessUnitId" TEXT NOT NULL DEFAULT 'production',
    "centerId" TEXT,
    "documentNumber" TEXT,
    "documentType" TEXT NOT NULL DEFAULT 'proforma',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "totalAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "finalAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL DEFAULT '',
    "issuedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "companyId" TEXT,
    "sourceDocumentId" TEXT,
    "paymentTerms" TEXT,
    "salesExpertName" TEXT,
    "salesExpertMobile" TEXT,
    "senderAddressType" TEXT,
    "buyerSnapshot" TEXT NOT NULL DEFAULT '',
    "pipelineStage" TEXT,

    CONSTRAINT "SalesDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesDocumentItem" (
    "id" TEXT NOT NULL,
    "salesDocumentId" TEXT NOT NULL,
    "productId" TEXT,
    "productName" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "unitPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL DEFAULT '',
    "unit" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesDocumentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesDocumentApproval" (
    "id" TEXT NOT NULL,
    "salesDocumentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "comment" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesDocumentApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesDocumentFinance" (
    "id" TEXT NOT NULL,
    "salesDocumentId" TEXT NOT NULL,
    "paymentMethod" TEXT,
    "paymentDate" TIMESTAMP(3),
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "referenceNumber" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesDocumentFinance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesDocumentLog" (
    "id" TEXT NOT NULL,
    "salesDocumentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "details" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesDocumentLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesDocumentVersion" (
    "id" TEXT NOT NULL,
    "salesDocumentId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "data" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesDocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesShipment" (
    "id" TEXT NOT NULL,
    "shipmentNumber" TEXT,
    "salesDocumentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'preparing',
    "carrierName" TEXT NOT NULL DEFAULT '',
    "trackingCode" TEXT NOT NULL DEFAULT '',
    "itemsSummary" TEXT NOT NULL DEFAULT '',
    "weight" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "dispatchedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesShipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CartonLabel" (
    "id" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "cartonIndex" INTEGER NOT NULL DEFAULT 1,
    "cartonTotal" INTEGER NOT NULL DEFAULT 1,
    "salesDocumentId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CartonLabel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssuedInvoice" (
    "id" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "centerAccountId" TEXT,
    "salesDocumentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "totalAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "paidAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "issuedAt" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IssuedInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssuedInvoiceItem" (
    "id" TEXT NOT NULL,
    "issuedInvoiceId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "unitPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "IssuedInvoiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssuedInvoicePayment" (
    "id" TEXT NOT NULL,
    "issuedInvoiceId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "paymentDate" TIMESTAMP(3),
    "referenceNumber" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssuedInvoicePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssuedInvoicePaymentIdempotency" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "idemKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "resultJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssuedInvoicePaymentIdempotency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesPaymentIdempotency" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "idemKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "salesDocumentId" TEXT NOT NULL,
    "financeRecordId" TEXT,
    "resultJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesPaymentIdempotency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventorySerial" (
    "id" TEXT NOT NULL,
    "productCode" TEXT,
    "serialNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'available',
    "centerId" TEXT,
    "companyId" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "soldAt" TIMESTAMP(3),
    "createdById" TEXT,
    "source" TEXT NOT NULL DEFAULT 'internal',
    "hesabfaItemCode" TEXT NOT NULL DEFAULT '',
    "hesabfaInvoiceNumber" TEXT NOT NULL DEFAULT '',
    "hesabfaInvoiceId" INTEGER NOT NULL DEFAULT 0,
    "hesabfaContactCode" TEXT NOT NULL DEFAULT '',
    "reservedById" TEXT,
    "reservedAt" TIMESTAMP(3),
    "reservationExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventorySerial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceTicket" (
    "id" TEXT NOT NULL,
    "businessUnitId" TEXT NOT NULL DEFAULT 'production',
    "ticketNumber" TEXT,
    "serialNumber" TEXT,
    "productCode" TEXT,
    "centerId" TEXT,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "type" TEXT NOT NULL DEFAULT 'repair',
    "status" TEXT NOT NULL DEFAULT 'open',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "warrantyStatus" TEXT NOT NULL DEFAULT 'unknown',
    "warrantyUntil" TIMESTAMP(3),
    "issue" TEXT NOT NULL DEFAULT '',
    "resolution" TEXT NOT NULL DEFAULT '',
    "cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "assignedTo" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ServiceTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceTicketLog" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "details" TEXT NOT NULL DEFAULT '{}',
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceTicketLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerPrice" (
    "id" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "minQty" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discountPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "commissionPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "note" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PartnerPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyTransaction" (
    "id" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT NOT NULL DEFAULT '',
    "documentNumber" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventorySerialHistory" (
    "id" TEXT NOT NULL,
    "serialId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventorySerialHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "color" TEXT NOT NULL DEFAULT 'default',
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Letter" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "senderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Letter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LetterRecipient" (
    "id" TEXT NOT NULL,
    "letterId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LetterRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "File" (
    "id" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "size" INTEGER NOT NULL DEFAULT 0,
    "checksum" TEXT,
    "centerId" TEXT,
    "category" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'committed',

    CONSTRAINT "File_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL DEFAULT '',
    "browserName" TEXT NOT NULL DEFAULT '',
    "ipHash" TEXT NOT NULL DEFAULT '',
    "impersonatedBy" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "attemptKey" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "firstFailedAt" TIMESTAMP(3),
    "lastFailedAt" TIMESTAMP(3),
    "blockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "subject" TEXT NOT NULL DEFAULT '',
    "details" TEXT NOT NULL DEFAULT '',
    "userId" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Meta" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Meta_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "SalesReport" (
    "id" TEXT NOT NULL,
    "businessUnitId" TEXT NOT NULL DEFAULT 'production',
    "companyId" TEXT,
    "reportDate" TEXT NOT NULL,
    "totalSales" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalInvoices" INTEGER NOT NULL DEFAULT 0,
    "totalProducts" INTEGER NOT NULL DEFAULT 0,
    "data" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionPurchaseRequest" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedBy" TEXT,
    "companyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductionPurchaseRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Territory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "province" TEXT,
    "userIds" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Territory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HesabfaCenterLink" (
    "id" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "hesabfaId" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HesabfaCenterLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HesabfaProductLink" (
    "id" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "hesabfaId" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HesabfaProductLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HesabfaJob" (
    "id" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "companyId" TEXT,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "result" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HesabfaJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HesabfaWebhookEvent" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HesabfaWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HesabfaReviewItem" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "action" TEXT NOT NULL DEFAULT 'create',
    "data" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HesabfaReviewItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HesabfaConnection" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "loginToken" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL DEFAULT 'https://api.hesabfa.com/v1',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "businessName" TEXT,
    "lastTestAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestMsg" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncStats" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HesabfaConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HesabfaWarehouseLink" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "warehouseCode" TEXT NOT NULL,
    "warehouseName" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HesabfaWarehouseLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HesabfaInventorySnapshot" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "itemCode" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT '',
    "warehouseCode" TEXT NOT NULL,
    "warehouseName" TEXT NOT NULL DEFAULT '',
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HesabfaInventorySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HesabfaItem" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "itemCode" TEXT NOT NULL,
    "hesabfaId" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL DEFAULT '',
    "barCode" TEXT NOT NULL DEFAULT '',
    "unit" TEXT NOT NULL DEFAULT '',
    "buyPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sellPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "categoryPath" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HesabfaItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HesabfaContact" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "hesabfaId" INTEGER NOT NULL,
    "code" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL DEFAULT '',
    "contactType" INTEGER NOT NULL DEFAULT 0,
    "phone" TEXT NOT NULL DEFAULT '',
    "mobile" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "province" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "nationalCode" TEXT NOT NULL DEFAULT '',
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HesabfaContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HesabfaInvoice" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "hesabfaId" INTEGER NOT NULL,
    "number" TEXT NOT NULL DEFAULT '',
    "invoiceType" INTEGER NOT NULL DEFAULT 0,
    "date" TEXT NOT NULL DEFAULT '',
    "contactHesabfaId" INTEGER NOT NULL DEFAULT 0,
    "contactCode" TEXT NOT NULL DEFAULT '',
    "contactName" TEXT NOT NULL DEFAULT '',
    "totalAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "paidAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL DEFAULT '',
    "itemsJson" TEXT NOT NULL DEFAULT '[]',
    "serialsJson" TEXT NOT NULL DEFAULT '[]',
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HesabfaInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PeriodicFollowup" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "centerId" TEXT,
    "centerName" TEXT NOT NULL,
    "city" TEXT,
    "personName" TEXT NOT NULL,
    "phone" TEXT,
    "frequency" TEXT NOT NULL,
    "frequencyDays" INTEGER NOT NULL DEFAULT 30,
    "lastFollowupDate" TEXT,
    "nextFollowupDate" TEXT,
    "daysOverdue" INTEGER NOT NULL DEFAULT 0,
    "totalFollowups" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'upcoming',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PeriodicFollowup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowupHistory" (
    "id" TEXT NOT NULL,
    "followupId" TEXT NOT NULL,
    "followupDate" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "result" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FollowupHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowupNote" (
    "id" TEXT NOT NULL,
    "followupId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FollowupNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCallRecording" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "centerId" TEXT,
    "contactId" TEXT,
    "activityId" TEXT,
    "userId" TEXT,
    "direction" TEXT NOT NULL DEFAULT 'outbound',
    "source" TEXT NOT NULL DEFAULT 'manual-upload',
    "provider" TEXT NOT NULL DEFAULT '',
    "externalId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "failReason" TEXT NOT NULL DEFAULT '',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "leaseToken" TEXT,
    "actionsDone" BOOLEAN NOT NULL DEFAULT false,
    "memoryDone" BOOLEAN NOT NULL DEFAULT false,
    "coachingDone" BOOLEAN NOT NULL DEFAULT false,
    "audioFileId" TEXT,
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "language" TEXT NOT NULL DEFAULT 'fa',
    "consent" TEXT NOT NULL DEFAULT 'unknown',
    "retentionUntil" TIMESTAMP(3),
    "title" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiCallRecording_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCallTranscript" (
    "id" TEXT NOT NULL,
    "recordingId" TEXT NOT NULL,
    "sttProvider" TEXT NOT NULL DEFAULT '',
    "language" TEXT NOT NULL DEFAULT 'fa',
    "fullText" TEXT NOT NULL DEFAULT '',
    "segments" TEXT NOT NULL DEFAULT '[]',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiCallTranscript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCallAnalysis" (
    "id" TEXT NOT NULL,
    "recordingId" TEXT NOT NULL,
    "llmProvider" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'completed',
    "summary" TEXT NOT NULL DEFAULT '',
    "topic" TEXT NOT NULL DEFAULT '',
    "callReason" TEXT NOT NULL DEFAULT '',
    "customerNeed" TEXT NOT NULL DEFAULT '',
    "customerProblems" TEXT NOT NULL DEFAULT '[]',
    "products" TEXT NOT NULL DEFAULT '[]',
    "budget" TEXT NOT NULL DEFAULT '',
    "purchaseTimeframe" TEXT NOT NULL DEFAULT '',
    "intent" TEXT NOT NULL DEFAULT '',
    "temperature" TEXT NOT NULL DEFAULT '',
    "conversionScore" INTEGER NOT NULL DEFAULT 0,
    "scoreReasons" TEXT NOT NULL DEFAULT '[]',
    "objections" TEXT NOT NULL DEFAULT '[]',
    "commitments" TEXT NOT NULL DEFAULT '{}',
    "openQuestions" TEXT NOT NULL DEFAULT '[]',
    "risks" TEXT NOT NULL DEFAULT '[]',
    "opportunities" TEXT NOT NULL DEFAULT '[]',
    "paymentTerms" TEXT NOT NULL DEFAULT '',
    "competitors" TEXT NOT NULL DEFAULT '[]',
    "decisionMakers" TEXT NOT NULL DEFAULT '[]',
    "suggestedFollowupDate" TIMESTAMP(3),
    "suggestedFollowupReason" TEXT NOT NULL DEFAULT '',
    "stageSuggestion" TEXT NOT NULL DEFAULT '',
    "nextActions" TEXT NOT NULL DEFAULT '[]',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCallAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCustomerMemory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "contactId" TEXT,
    "summary" TEXT NOT NULL DEFAULT '',
    "preferences" TEXT NOT NULL DEFAULT '{}',
    "insights" TEXT NOT NULL DEFAULT '{}',
    "source" TEXT NOT NULL DEFAULT 'ai',
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiCustomerMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiNextAction" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "centerId" TEXT,
    "contactId" TEXT,
    "recordingId" TEXT,
    "analysisId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "dueAt" TIMESTAMP(3),
    "reason" TEXT NOT NULL DEFAULT '',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'suggested',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "executedActivityId" TEXT,
    "assignedTo" TEXT,
    "createdById" TEXT,
    "executedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "dismissedReason" TEXT NOT NULL DEFAULT '',
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiNextAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCoachInsight" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "recordingId" TEXT NOT NULL,
    "analysisId" TEXT,
    "qualityScore" INTEGER NOT NULL DEFAULT 0,
    "scores" TEXT NOT NULL DEFAULT '{}',
    "strengths" TEXT NOT NULL DEFAULT '[]',
    "improvements" TEXT NOT NULL DEFAULT '[]',
    "mistakes" TEXT NOT NULL DEFAULT '[]',
    "recommendations" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCoachInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiUsageLog" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT,
    "feature" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "audioSeconds" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostRial" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'success',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsageLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiPlaybook" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceRecordingId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiPlaybook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_slug_key" ON "Company"("slug");

-- CreateIndex
CREATE INDEX "SmsLog_companyId_createdAt_idx" ON "SmsLog"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "SmsLog_userId_createdAt_idx" ON "SmsLog"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "User_businessUnitId_idx" ON "User"("businessUnitId");

-- CreateIndex
CREATE INDEX "User_companyId_idx" ON "User"("companyId");

-- CreateIndex
CREATE INDEX "Center_businessUnitId_status_idx" ON "Center"("businessUnitId", "status");

-- CreateIndex
CREATE INDEX "Center_businessUnitId_isArchived_idx" ON "Center"("businessUnitId", "isArchived");

-- CreateIndex
CREATE INDEX "Center_province_idx" ON "Center"("province");

-- CreateIndex
CREATE INDEX "Center_companyId_idx" ON "Center"("companyId");

-- CreateIndex
CREATE INDEX "Center_updatedAt_idx" ON "Center"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CenterAccount_centerId_key" ON "CenterAccount"("centerId");

-- CreateIndex
CREATE INDEX "CenterContact_centerId_idx" ON "CenterContact"("centerId");

-- CreateIndex
CREATE INDEX "ContactProfileNote_contactId_idx" ON "ContactProfileNote"("contactId");

-- CreateIndex
CREATE INDEX "Activity_assignedTo_status_idx" ON "Activity"("assignedTo", "status");

-- CreateIndex
CREATE INDEX "Activity_centerId_idx" ON "Activity"("centerId");

-- CreateIndex
CREATE INDEX "Activity_activityDate_idx" ON "Activity"("activityDate");

-- CreateIndex
CREATE INDEX "Activity_businessUnitId_activityDate_idx" ON "Activity"("businessUnitId", "activityDate");

-- CreateIndex
CREATE INDEX "Activity_businessUnitId_isPhoneCall_activityDate_idx" ON "Activity"("businessUnitId", "isPhoneCall", "activityDate");

-- CreateIndex
CREATE INDEX "Activity_createdById_idx" ON "Activity"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "Product_code_key" ON "Product"("code");

-- CreateIndex
CREATE INDEX "Product_companyId_idx" ON "Product"("companyId");

-- CreateIndex
CREATE INDEX "SalesDocument_businessUnitId_status_idx" ON "SalesDocument"("businessUnitId", "status");

-- CreateIndex
CREATE INDEX "SalesDocument_centerId_idx" ON "SalesDocument"("centerId");

-- CreateIndex
CREATE INDEX "SalesDocument_companyId_idx" ON "SalesDocument"("companyId");

-- CreateIndex
CREATE INDEX "SalesDocument_sourceDocumentId_idx" ON "SalesDocument"("sourceDocumentId");

-- CreateIndex
CREATE INDEX "SalesDocument_documentNumber_idx" ON "SalesDocument"("documentNumber");

-- CreateIndex
CREATE INDEX "SalesDocument_createdAt_idx" ON "SalesDocument"("createdAt");

-- CreateIndex
CREATE INDEX "SalesDocument_documentType_status_idx" ON "SalesDocument"("documentType", "status");

-- CreateIndex
CREATE INDEX "SalesDocument_issuedAt_idx" ON "SalesDocument"("issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SalesDocument_documentNumber_key" ON "SalesDocument"("documentNumber");

-- CreateIndex
CREATE INDEX "SalesDocumentItem_salesDocumentId_idx" ON "SalesDocumentItem"("salesDocumentId");

-- CreateIndex
CREATE INDEX "SalesDocumentApproval_salesDocumentId_idx" ON "SalesDocumentApproval"("salesDocumentId");

-- CreateIndex
CREATE INDEX "SalesDocumentFinance_salesDocumentId_idx" ON "SalesDocumentFinance"("salesDocumentId");

-- CreateIndex
CREATE INDEX "SalesDocumentFinance_createdById_idx" ON "SalesDocumentFinance"("createdById");

-- CreateIndex
CREATE INDEX "SalesDocumentLog_salesDocumentId_idx" ON "SalesDocumentLog"("salesDocumentId");

-- CreateIndex
CREATE INDEX "SalesDocumentVersion_salesDocumentId_idx" ON "SalesDocumentVersion"("salesDocumentId");

-- CreateIndex
CREATE INDEX "SalesShipment_salesDocumentId_idx" ON "SalesShipment"("salesDocumentId");

-- CreateIndex
CREATE INDEX "SalesShipment_status_idx" ON "SalesShipment"("status");

-- CreateIndex
CREATE INDEX "SalesShipment_createdAt_idx" ON "SalesShipment"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CartonLabel_serial_key" ON "CartonLabel"("serial");

-- CreateIndex
CREATE INDEX "CartonLabel_shipmentId_idx" ON "CartonLabel"("shipmentId");

-- CreateIndex
CREATE INDEX "CartonLabel_salesDocumentId_idx" ON "CartonLabel"("salesDocumentId");

-- CreateIndex
CREATE INDEX "CartonLabel_createdAt_idx" ON "CartonLabel"("createdAt");

-- CreateIndex
CREATE INDEX "IssuedInvoice_centerAccountId_idx" ON "IssuedInvoice"("centerAccountId");

-- CreateIndex
CREATE INDEX "IssuedInvoice_salesDocumentId_idx" ON "IssuedInvoice"("salesDocumentId");

-- CreateIndex
CREATE INDEX "IssuedInvoice_status_idx" ON "IssuedInvoice"("status");

-- CreateIndex
CREATE INDEX "IssuedInvoice_status_dueDate_idx" ON "IssuedInvoice"("status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "IssuedInvoice_invoiceNumber_key" ON "IssuedInvoice"("invoiceNumber");

-- CreateIndex
CREATE INDEX "IssuedInvoiceItem_issuedInvoiceId_idx" ON "IssuedInvoiceItem"("issuedInvoiceId");

-- CreateIndex
CREATE INDEX "IssuedInvoicePayment_issuedInvoiceId_idx" ON "IssuedInvoicePayment"("issuedInvoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "IssuedInvoicePaymentIdempotency_paymentId_key" ON "IssuedInvoicePaymentIdempotency"("paymentId");

-- CreateIndex
CREATE INDEX "IssuedInvoicePaymentIdempotency_invoiceId_idx" ON "IssuedInvoicePaymentIdempotency"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "IssuedInvoicePaymentIdempotency_userId_idemKey_key" ON "IssuedInvoicePaymentIdempotency"("userId", "idemKey");

-- CreateIndex
CREATE UNIQUE INDEX "SalesPaymentIdempotency_financeRecordId_key" ON "SalesPaymentIdempotency"("financeRecordId");

-- CreateIndex
CREATE INDEX "SalesPaymentIdempotency_salesDocumentId_idx" ON "SalesPaymentIdempotency"("salesDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesPaymentIdempotency_userId_idemKey_key" ON "SalesPaymentIdempotency"("userId", "idemKey");

-- CreateIndex
CREATE UNIQUE INDEX "InventorySerial_serialNumber_key" ON "InventorySerial"("serialNumber");

-- CreateIndex
CREATE INDEX "InventorySerial_centerId_idx" ON "InventorySerial"("centerId");

-- CreateIndex
CREATE INDEX "InventorySerial_companyId_idx" ON "InventorySerial"("companyId");

-- CreateIndex
CREATE INDEX "InventorySerial_status_idx" ON "InventorySerial"("status");

-- CreateIndex
CREATE INDEX "InventorySerial_productCode_idx" ON "InventorySerial"("productCode");

-- CreateIndex
CREATE INDEX "InventorySerial_source_hesabfaInvoiceNumber_idx" ON "InventorySerial"("source", "hesabfaInvoiceNumber");

-- CreateIndex
CREATE INDEX "InventorySerial_updatedAt_idx" ON "InventorySerial"("updatedAt");

-- CreateIndex
CREATE INDEX "ServiceTicket_businessUnitId_status_idx" ON "ServiceTicket"("businessUnitId", "status");

-- CreateIndex
CREATE INDEX "ServiceTicket_businessUnitId_warrantyStatus_status_idx" ON "ServiceTicket"("businessUnitId", "warrantyStatus", "status");

-- CreateIndex
CREATE INDEX "ServiceTicket_serialNumber_idx" ON "ServiceTicket"("serialNumber");

-- CreateIndex
CREATE INDEX "ServiceTicket_centerId_idx" ON "ServiceTicket"("centerId");

-- CreateIndex
CREATE INDEX "ServiceTicketLog_ticketId_idx" ON "ServiceTicketLog"("ticketId");

-- CreateIndex
CREATE INDEX "PartnerPrice_productCode_active_idx" ON "PartnerPrice"("productCode", "active");

-- CreateIndex
CREATE INDEX "LoyaltyTransaction_centerId_createdAt_idx" ON "LoyaltyTransaction"("centerId", "createdAt");

-- CreateIndex
CREATE INDEX "InventorySerialHistory_serialId_idx" ON "InventorySerialHistory"("serialId");

-- CreateIndex
CREATE INDEX "Note_userId_idx" ON "Note"("userId");

-- CreateIndex
CREATE INDEX "LetterRecipient_letterId_idx" ON "LetterRecipient"("letterId");

-- CreateIndex
CREATE INDEX "LetterRecipient_userId_isRead_idx" ON "LetterRecipient"("userId", "isRead");

-- CreateIndex
CREATE UNIQUE INDEX "File_storedName_key" ON "File"("storedName");

-- CreateIndex
CREATE INDEX "File_centerId_idx" ON "File"("centerId");

-- CreateIndex
CREATE INDEX "File_createdById_idx" ON "File"("createdById");

-- CreateIndex
CREATE INDEX "File_status_idx" ON "File"("status");

-- CreateIndex
CREATE INDEX "Session_userId_revokedAt_idx" ON "Session"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "Session_lastSeenAt_idx" ON "Session"("lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "LoginAttempt_attemptKey_key" ON "LoginAttempt"("attemptKey");

-- CreateIndex
CREATE INDEX "LoginAttempt_userId_idx" ON "LoginAttempt"("userId");

-- CreateIndex
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_userId_idx" ON "AuditEvent"("userId");

-- CreateIndex
CREATE INDEX "AuditEvent_eventType_idx" ON "AuditEvent"("eventType");

-- CreateIndex
CREATE INDEX "SalesReport_businessUnitId_reportDate_idx" ON "SalesReport"("businessUnitId", "reportDate");

-- CreateIndex
CREATE INDEX "ProductionPurchaseRequest_companyId_idx" ON "ProductionPurchaseRequest"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Territory_name_key" ON "Territory"("name");

-- CreateIndex
CREATE UNIQUE INDEX "HesabfaCenterLink_centerId_key" ON "HesabfaCenterLink"("centerId");

-- CreateIndex
CREATE UNIQUE INDEX "HesabfaProductLink_productCode_key" ON "HesabfaProductLink"("productCode");

-- CreateIndex
CREATE INDEX "HesabfaJob_status_idx" ON "HesabfaJob"("status");

-- CreateIndex
CREATE INDEX "HesabfaJob_companyId_status_idx" ON "HesabfaJob"("companyId", "status");

-- CreateIndex
CREATE INDEX "HesabfaWebhookEvent_processed_idx" ON "HesabfaWebhookEvent"("processed");

-- CreateIndex
CREATE INDEX "HesabfaReviewItem_jobId_idx" ON "HesabfaReviewItem"("jobId");

-- CreateIndex
CREATE INDEX "HesabfaReviewItem_status_idx" ON "HesabfaReviewItem"("status");

-- CreateIndex
CREATE UNIQUE INDEX "HesabfaConnection_companyId_key" ON "HesabfaConnection"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "HesabfaWarehouseLink_companyId_warehouseCode_key" ON "HesabfaWarehouseLink"("companyId", "warehouseCode");

-- CreateIndex
CREATE INDEX "HesabfaInventorySnapshot_companyId_warehouseCode_idx" ON "HesabfaInventorySnapshot"("companyId", "warehouseCode");

-- CreateIndex
CREATE INDEX "HesabfaInventorySnapshot_itemCode_idx" ON "HesabfaInventorySnapshot"("itemCode");

-- CreateIndex
CREATE UNIQUE INDEX "HesabfaInventorySnapshot_companyId_itemCode_warehouseCode_key" ON "HesabfaInventorySnapshot"("companyId", "itemCode", "warehouseCode");

-- CreateIndex
CREATE INDEX "HesabfaItem_companyId_active_idx" ON "HesabfaItem"("companyId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "HesabfaItem_companyId_itemCode_key" ON "HesabfaItem"("companyId", "itemCode");

-- CreateIndex
CREATE UNIQUE INDEX "HesabfaContact_companyId_hesabfaId_key" ON "HesabfaContact"("companyId", "hesabfaId");

-- CreateIndex
CREATE UNIQUE INDEX "HesabfaContact_companyId_code_key" ON "HesabfaContact"("companyId", "code");

-- CreateIndex
CREATE INDEX "HesabfaInvoice_companyId_invoiceType_date_idx" ON "HesabfaInvoice"("companyId", "invoiceType", "date");

-- CreateIndex
CREATE INDEX "HesabfaInvoice_companyId_contactHesabfaId_idx" ON "HesabfaInvoice"("companyId", "contactHesabfaId");

-- CreateIndex
CREATE UNIQUE INDEX "HesabfaInvoice_companyId_hesabfaId_key" ON "HesabfaInvoice"("companyId", "hesabfaId");

-- CreateIndex
CREATE INDEX "PeriodicFollowup_companyId_status_idx" ON "PeriodicFollowup"("companyId", "status");

-- CreateIndex
CREATE INDEX "PeriodicFollowup_centerId_idx" ON "PeriodicFollowup"("centerId");

-- CreateIndex
CREATE INDEX "FollowupHistory_followupId_idx" ON "FollowupHistory"("followupId");

-- CreateIndex
CREATE INDEX "FollowupNote_followupId_idx" ON "FollowupNote"("followupId");

-- CreateIndex
CREATE INDEX "AiCallRecording_companyId_status_idx" ON "AiCallRecording"("companyId", "status");

-- CreateIndex
CREATE INDEX "AiCallRecording_centerId_createdAt_idx" ON "AiCallRecording"("centerId", "createdAt");

-- CreateIndex
CREATE INDEX "AiCallRecording_userId_createdAt_idx" ON "AiCallRecording"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AiCallRecording_createdAt_idx" ON "AiCallRecording"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiCallRecording_provider_externalId_key" ON "AiCallRecording"("provider", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "AiCallTranscript_recordingId_key" ON "AiCallTranscript"("recordingId");

-- CreateIndex
CREATE INDEX "AiCallAnalysis_recordingId_createdAt_idx" ON "AiCallAnalysis"("recordingId", "createdAt");

-- CreateIndex
CREATE INDEX "AiCustomerMemory_centerId_contactId_idx" ON "AiCustomerMemory"("centerId", "contactId");

-- CreateIndex
CREATE INDEX "AiCustomerMemory_companyId_idx" ON "AiCustomerMemory"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "AiNextAction_dedupeKey_key" ON "AiNextAction"("dedupeKey");

-- CreateIndex
CREATE INDEX "AiNextAction_companyId_status_idx" ON "AiNextAction"("companyId", "status");

-- CreateIndex
CREATE INDEX "AiNextAction_assignedTo_status_idx" ON "AiNextAction"("assignedTo", "status");

-- CreateIndex
CREATE INDEX "AiNextAction_dueAt_status_idx" ON "AiNextAction"("dueAt", "status");

-- CreateIndex
CREATE INDEX "AiCoachInsight_userId_createdAt_idx" ON "AiCoachInsight"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AiUsageLog_companyId_createdAt_idx" ON "AiUsageLog"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "AiUsageLog_feature_createdAt_idx" ON "AiUsageLog"("feature", "createdAt");

-- CreateIndex
CREATE INDEX "AiPlaybook_companyId_category_idx" ON "AiPlaybook"("companyId", "category");

-- AddForeignKey
ALTER TABLE "SmsLog" ADD CONSTRAINT "SmsLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmsLog" ADD CONSTRAINT "SmsLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "BusinessUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Center" ADD CONSTRAINT "Center_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "BusinessUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Center" ADD CONSTRAINT "Center_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CenterAccount" ADD CONSTRAINT "CenterAccount_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CenterContact" ADD CONSTRAINT "CenterContact_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactProfileNote" ADD CONSTRAINT "ContactProfileNote_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "CenterContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "BusinessUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_assignedTo_fkey" FOREIGN KEY ("assignedTo") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_voiceNoteFileId_fkey" FOREIGN KEY ("voiceNoteFileId") REFERENCES "File"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDocument" ADD CONSTRAINT "SalesDocument_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "BusinessUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDocument" ADD CONSTRAINT "SalesDocument_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDocument" ADD CONSTRAINT "SalesDocument_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDocument" ADD CONSTRAINT "SalesDocument_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "SalesDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDocument" ADD CONSTRAINT "SalesDocument_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDocument" ADD CONSTRAINT "SalesDocument_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDocument" ADD CONSTRAINT "SalesDocument_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDocumentItem" ADD CONSTRAINT "SalesDocumentItem_salesDocumentId_fkey" FOREIGN KEY ("salesDocumentId") REFERENCES "SalesDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDocumentItem" ADD CONSTRAINT "SalesDocumentItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDocumentApproval" ADD CONSTRAINT "SalesDocumentApproval_salesDocumentId_fkey" FOREIGN KEY ("salesDocumentId") REFERENCES "SalesDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDocumentFinance" ADD CONSTRAINT "SalesDocumentFinance_salesDocumentId_fkey" FOREIGN KEY ("salesDocumentId") REFERENCES "SalesDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDocumentLog" ADD CONSTRAINT "SalesDocumentLog_salesDocumentId_fkey" FOREIGN KEY ("salesDocumentId") REFERENCES "SalesDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDocumentVersion" ADD CONSTRAINT "SalesDocumentVersion_salesDocumentId_fkey" FOREIGN KEY ("salesDocumentId") REFERENCES "SalesDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesShipment" ADD CONSTRAINT "SalesShipment_salesDocumentId_fkey" FOREIGN KEY ("salesDocumentId") REFERENCES "SalesDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesShipment" ADD CONSTRAINT "SalesShipment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartonLabel" ADD CONSTRAINT "CartonLabel_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "SalesShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartonLabel" ADD CONSTRAINT "CartonLabel_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedInvoice" ADD CONSTRAINT "IssuedInvoice_centerAccountId_fkey" FOREIGN KEY ("centerAccountId") REFERENCES "CenterAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedInvoice" ADD CONSTRAINT "IssuedInvoice_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedInvoice" ADD CONSTRAINT "IssuedInvoice_salesDocumentId_fkey" FOREIGN KEY ("salesDocumentId") REFERENCES "SalesDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedInvoiceItem" ADD CONSTRAINT "IssuedInvoiceItem_issuedInvoiceId_fkey" FOREIGN KEY ("issuedInvoiceId") REFERENCES "IssuedInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedInvoicePayment" ADD CONSTRAINT "IssuedInvoicePayment_issuedInvoiceId_fkey" FOREIGN KEY ("issuedInvoiceId") REFERENCES "IssuedInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventorySerial" ADD CONSTRAINT "InventorySerial_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceTicket" ADD CONSTRAINT "ServiceTicket_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceTicket" ADD CONSTRAINT "ServiceTicket_serialNumber_fkey" FOREIGN KEY ("serialNumber") REFERENCES "InventorySerial"("serialNumber") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceTicket" ADD CONSTRAINT "ServiceTicket_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "BusinessUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceTicketLog" ADD CONSTRAINT "ServiceTicketLog_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "ServiceTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyTransaction" ADD CONSTRAINT "LoyaltyTransaction_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventorySerialHistory" ADD CONSTRAINT "InventorySerialHistory_serialId_fkey" FOREIGN KEY ("serialId") REFERENCES "InventorySerial"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LetterRecipient" ADD CONSTRAINT "LetterRecipient_letterId_fkey" FOREIGN KEY ("letterId") REFERENCES "Letter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoginAttempt" ADD CONSTRAINT "LoginAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesReport" ADD CONSTRAINT "SalesReport_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionPurchaseRequest" ADD CONSTRAINT "ProductionPurchaseRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HesabfaConnection" ADD CONSTRAINT "HesabfaConnection_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HesabfaWarehouseLink" ADD CONSTRAINT "HesabfaWarehouseLink_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "HesabfaConnection"("companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeriodicFollowup" ADD CONSTRAINT "PeriodicFollowup_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeriodicFollowup" ADD CONSTRAINT "PeriodicFollowup_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowupHistory" ADD CONSTRAINT "FollowupHistory_followupId_fkey" FOREIGN KEY ("followupId") REFERENCES "PeriodicFollowup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowupNote" ADD CONSTRAINT "FollowupNote_followupId_fkey" FOREIGN KEY ("followupId") REFERENCES "PeriodicFollowup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCallRecording" ADD CONSTRAINT "AiCallRecording_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCallRecording" ADD CONSTRAINT "AiCallRecording_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "CenterContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCallRecording" ADD CONSTRAINT "AiCallRecording_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCallRecording" ADD CONSTRAINT "AiCallRecording_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCallTranscript" ADD CONSTRAINT "AiCallTranscript_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "AiCallRecording"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCallAnalysis" ADD CONSTRAINT "AiCallAnalysis_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "AiCallRecording"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCustomerMemory" ADD CONSTRAINT "AiCustomerMemory_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCustomerMemory" ADD CONSTRAINT "AiCustomerMemory_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "CenterContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiNextAction" ADD CONSTRAINT "AiNextAction_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiNextAction" ADD CONSTRAINT "AiNextAction_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "CenterContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiNextAction" ADD CONSTRAINT "AiNextAction_assignedTo_fkey" FOREIGN KEY ("assignedTo") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCoachInsight" ADD CONSTRAINT "AiCoachInsight_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCoachInsight" ADD CONSTRAINT "AiCoachInsight_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "AiCallRecording"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCoachInsight" ADD CONSTRAINT "AiCoachInsight_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "AiCallAnalysis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

