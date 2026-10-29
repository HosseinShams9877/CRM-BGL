-- CreateTable
CREATE TABLE "BusinessUnit" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'production',
    "name" TEXT NOT NULL,
    "label" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "features" TEXT NOT NULL DEFAULT '{}',
    "userIds" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "isIsolated" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SmsLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SmsLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SmsLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'standard',
    "roleLabel" TEXT NOT NULL DEFAULT 'کاربر عادی',
    "jobTitle" TEXT,
    "province" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "companyIds" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "businessUnitId" TEXT NOT NULL DEFAULT 'production',
    "companyId" TEXT,
    "territoryMode" TEXT NOT NULL DEFAULT 'country',
    "territoryProvinces" TEXT NOT NULL DEFAULT '[]',
    "territoryCenterIds" TEXT NOT NULL DEFAULT '[]',
    "territoryUpdatedAt" DATETIME,
    CONSTRAINT "User_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "BusinessUnit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "User_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Center" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessUnitId" TEXT NOT NULL DEFAULT 'production',
    "companyId" TEXT NOT NULL DEFAULT 'bazargani',
    "name" TEXT NOT NULL,
    "customerType" TEXT NOT NULL DEFAULT 'organization',
    "segment" TEXT NOT NULL DEFAULT '',
    "mobile" TEXT,
    "loyaltyPoints" INTEGER NOT NULL DEFAULT 0,
    "creditScore" INTEGER NOT NULL DEFAULT 0,
    "paymentBehavior" TEXT NOT NULL DEFAULT 'unknown',
    "commissionPercent" REAL NOT NULL DEFAULT 0,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "Center_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "BusinessUnit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Center_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CenterAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "centerId" TEXT NOT NULL,
    "totalSales" REAL NOT NULL DEFAULT 0,
    "totalPaid" REAL NOT NULL DEFAULT 0,
    "balance" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CenterAccount_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CenterContact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "centerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "person" TEXT,
    "phone" TEXT NOT NULL,
    "notes" TEXT,
    "isAgent" BOOLEAN NOT NULL DEFAULT false,
    "personality" TEXT NOT NULL DEFAULT '{}',
    "createdBy" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "CenterContact_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ContactProfileNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "content" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContactProfileNote_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "CenterContact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessUnitId" TEXT NOT NULL DEFAULT 'production',
    "centerId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "activityDate" DATETIME NOT NULL,
    "activityTime" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "completedAt" DATETIME,
    "isPhoneCall" BOOLEAN NOT NULL DEFAULT false,
    "isOnsiteVisit" BOOLEAN NOT NULL DEFAULT false,
    "isUnansweredCall" BOOLEAN NOT NULL DEFAULT false,
    "assignedTo" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "voiceNoteFileId" TEXT,
    "voiceTranscript" TEXT NOT NULL DEFAULT '',
    "products" TEXT NOT NULL DEFAULT '[]',
    CONSTRAINT "Activity_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "BusinessUnit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Activity_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Activity_assignedTo_fkey" FOREIGN KEY ("assignedTo") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Activity_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Activity_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Activity_voiceNoteFileId_fkey" FOREIGN KEY ("voiceNoteFileId") REFERENCES "File" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" REAL NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL DEFAULT 'عدد',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'دستی',
    "category" TEXT NOT NULL DEFAULT '',
    "specs" TEXT NOT NULL DEFAULT '{}',
    "warrantyMonths" INTEGER NOT NULL DEFAULT 12,
    "ircCode" TEXT,
    "companyId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "Product_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SalesDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessUnitId" TEXT NOT NULL DEFAULT 'production',
    "centerId" TEXT,
    "documentNumber" TEXT,
    "documentType" TEXT NOT NULL DEFAULT 'proforma',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "totalAmount" REAL NOT NULL DEFAULT 0,
    "discountAmount" REAL NOT NULL DEFAULT 0,
    "taxAmount" REAL NOT NULL DEFAULT 0,
    "finalAmount" REAL NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL DEFAULT '',
    "issuedAt" DATETIME,
    "approvedById" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "companyId" TEXT,
    "sourceDocumentId" TEXT,
    "paymentTerms" TEXT,
    "salesExpertName" TEXT,
    "salesExpertMobile" TEXT,
    "senderAddressType" TEXT,
    "buyerSnapshot" TEXT NOT NULL DEFAULT '',
    "pipelineStage" TEXT,
    CONSTRAINT "SalesDocument_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "BusinessUnit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SalesDocument_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SalesDocument_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SalesDocument_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "SalesDocument" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SalesDocument_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SalesDocument_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SalesDocument_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SalesDocumentItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "salesDocumentId" TEXT NOT NULL,
    "productId" TEXT,
    "productName" TEXT NOT NULL,
    "quantity" REAL NOT NULL DEFAULT 1,
    "unitPrice" REAL NOT NULL DEFAULT 0,
    "totalPrice" REAL NOT NULL DEFAULT 0,
    "discount" REAL NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL DEFAULT '',
    "unit" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SalesDocumentItem_salesDocumentId_fkey" FOREIGN KEY ("salesDocumentId") REFERENCES "SalesDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SalesDocumentItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SalesDocumentApproval" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "salesDocumentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "comment" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SalesDocumentApproval_salesDocumentId_fkey" FOREIGN KEY ("salesDocumentId") REFERENCES "SalesDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SalesDocumentFinance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "salesDocumentId" TEXT NOT NULL,
    "paymentMethod" TEXT,
    "paymentDate" DATETIME,
    "amount" REAL NOT NULL DEFAULT 0,
    "referenceNumber" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SalesDocumentFinance_salesDocumentId_fkey" FOREIGN KEY ("salesDocumentId") REFERENCES "SalesDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SalesDocumentLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "salesDocumentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "details" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SalesDocumentLog_salesDocumentId_fkey" FOREIGN KEY ("salesDocumentId") REFERENCES "SalesDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SalesDocumentVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "salesDocumentId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "data" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SalesDocumentVersion_salesDocumentId_fkey" FOREIGN KEY ("salesDocumentId") REFERENCES "SalesDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SalesShipment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shipmentNumber" TEXT,
    "salesDocumentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'preparing',
    "carrierName" TEXT NOT NULL DEFAULT '',
    "trackingCode" TEXT NOT NULL DEFAULT '',
    "itemsSummary" TEXT NOT NULL DEFAULT '',
    "weight" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "dispatchedAt" DATETIME,
    "deliveredAt" DATETIME,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SalesShipment_salesDocumentId_fkey" FOREIGN KEY ("salesDocumentId") REFERENCES "SalesDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SalesShipment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CartonLabel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serial" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "cartonIndex" INTEGER NOT NULL DEFAULT 1,
    "cartonTotal" INTEGER NOT NULL DEFAULT 1,
    "salesDocumentId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CartonLabel_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "SalesShipment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CartonLabel_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IssuedInvoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceNumber" TEXT,
    "centerAccountId" TEXT,
    "salesDocumentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "totalAmount" REAL NOT NULL DEFAULT 0,
    "paidAmount" REAL NOT NULL DEFAULT 0,
    "issuedAt" DATETIME,
    "dueDate" DATETIME,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "IssuedInvoice_centerAccountId_fkey" FOREIGN KEY ("centerAccountId") REFERENCES "CenterAccount" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "IssuedInvoice_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "IssuedInvoice_salesDocumentId_fkey" FOREIGN KEY ("salesDocumentId") REFERENCES "SalesDocument" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IssuedInvoiceItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "issuedInvoiceId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" REAL NOT NULL DEFAULT 1,
    "unitPrice" REAL NOT NULL DEFAULT 0,
    "totalPrice" REAL NOT NULL DEFAULT 0,
    CONSTRAINT "IssuedInvoiceItem_issuedInvoiceId_fkey" FOREIGN KEY ("issuedInvoiceId") REFERENCES "IssuedInvoice" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IssuedInvoicePayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "issuedInvoiceId" TEXT NOT NULL,
    "amount" REAL NOT NULL DEFAULT 0,
    "paymentDate" DATETIME,
    "referenceNumber" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IssuedInvoicePayment_issuedInvoiceId_fkey" FOREIGN KEY ("issuedInvoiceId") REFERENCES "IssuedInvoice" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InventorySerial" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productCode" TEXT,
    "serialNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'available',
    "centerId" TEXT,
    "companyId" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "soldAt" DATETIME,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InventorySerial_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ServiceTicket" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "warrantyUntil" DATETIME,
    "issue" TEXT NOT NULL DEFAULT '',
    "resolution" TEXT NOT NULL DEFAULT '',
    "cost" REAL NOT NULL DEFAULT 0,
    "assignedTo" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "ServiceTicket_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ServiceTicket_serialNumber_fkey" FOREIGN KEY ("serialNumber") REFERENCES "InventorySerial" ("serialNumber") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ServiceTicket_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "BusinessUnit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ServiceTicketLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticketId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "details" TEXT NOT NULL DEFAULT '{}',
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ServiceTicketLog_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "ServiceTicket" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PartnerPrice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productCode" TEXT NOT NULL,
    "minQty" REAL NOT NULL DEFAULT 1,
    "price" REAL NOT NULL DEFAULT 0,
    "discountPercent" REAL NOT NULL DEFAULT 0,
    "commissionPercent" REAL NOT NULL DEFAULT 0,
    "note" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1
);

-- CreateTable
CREATE TABLE "LoyaltyTransaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "centerId" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT NOT NULL DEFAULT '',
    "documentNumber" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LoyaltyTransaction_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InventorySerialHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serialId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InventorySerialHistory_serialId_fkey" FOREIGN KEY ("serialId") REFERENCES "InventorySerial" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "color" TEXT NOT NULL DEFAULT 'default',
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Note_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Letter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "senderId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "LetterRecipient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "letterId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LetterRecipient_letterId_fkey" FOREIGN KEY ("letterId") REFERENCES "Letter" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "File" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "originalName" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "size" INTEGER NOT NULL DEFAULT 0,
    "checksum" TEXT,
    "centerId" TEXT,
    "category" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL DEFAULT '',
    "browserName" TEXT NOT NULL DEFAULT '',
    "ipHash" TEXT NOT NULL DEFAULT '',
    "impersonatedBy" TEXT,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attemptKey" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "firstFailedAt" DATETIME,
    "lastFailedAt" DATETIME,
    "blockedUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    CONSTRAINT "LoginAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventType" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "subject" TEXT NOT NULL DEFAULT '',
    "details" TEXT NOT NULL DEFAULT '',
    "userId" TEXT,
    "ipAddress" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Meta" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL DEFAULT '',
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SalesReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessUnitId" TEXT NOT NULL DEFAULT 'production',
    "companyId" TEXT,
    "reportDate" TEXT NOT NULL,
    "totalSales" REAL NOT NULL DEFAULT 0,
    "totalInvoices" INTEGER NOT NULL DEFAULT 0,
    "totalProducts" INTEGER NOT NULL DEFAULT 0,
    "data" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SalesReport_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProductionPurchaseRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedBy" TEXT,
    "companyId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProductionPurchaseRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Territory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "province" TEXT,
    "userIds" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "HesabfaCenterLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "centerId" TEXT NOT NULL,
    "hesabfaId" TEXT NOT NULL,
    "syncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "HesabfaProductLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productCode" TEXT NOT NULL,
    "hesabfaId" TEXT NOT NULL,
    "syncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "HesabfaJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "companyId" TEXT,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "result" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "HesabfaWebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventType" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "HesabfaReviewItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "action" TEXT NOT NULL DEFAULT 'create',
    "data" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "HesabfaConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "loginToken" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL DEFAULT 'https://api.hesabfa.com/v1',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "businessName" TEXT,
    "lastTestAt" DATETIME,
    "lastTestOk" BOOLEAN,
    "lastTestMsg" TEXT,
    "lastSyncAt" DATETIME,
    "lastSyncStats" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "HesabfaConnection_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HesabfaWarehouseLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "warehouseCode" TEXT NOT NULL,
    "warehouseName" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "HesabfaWarehouseLink_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "HesabfaConnection" ("companyId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HesabfaInventorySnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "itemCode" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT '',
    "warehouseCode" TEXT NOT NULL,
    "warehouseName" TEXT NOT NULL DEFAULT '',
    "quantity" REAL NOT NULL DEFAULT 0,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PeriodicFollowup" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PeriodicFollowup_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PeriodicFollowup_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FollowupHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "followupId" TEXT NOT NULL,
    "followupDate" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "result" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FollowupHistory_followupId_fkey" FOREIGN KEY ("followupId") REFERENCES "PeriodicFollowup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FollowupNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "followupId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FollowupNote_followupId_fkey" FOREIGN KEY ("followupId") REFERENCES "PeriodicFollowup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiCallRecording" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "audioFileId" TEXT,
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "language" TEXT NOT NULL DEFAULT 'fa',
    "consent" TEXT NOT NULL DEFAULT 'unknown',
    "retentionUntil" DATETIME,
    "title" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AiCallRecording_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AiCallRecording_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "CenterContact" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AiCallRecording_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AiCallRecording_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiCallTranscript" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recordingId" TEXT NOT NULL,
    "sttProvider" TEXT NOT NULL DEFAULT '',
    "language" TEXT NOT NULL DEFAULT 'fa',
    "fullText" TEXT NOT NULL DEFAULT '',
    "segments" TEXT NOT NULL DEFAULT '[]',
    "confidence" REAL NOT NULL DEFAULT 0,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AiCallTranscript_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "AiCallRecording" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiCallAnalysis" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "suggestedFollowupDate" DATETIME,
    "suggestedFollowupReason" TEXT NOT NULL DEFAULT '',
    "stageSuggestion" TEXT NOT NULL DEFAULT '',
    "nextActions" TEXT NOT NULL DEFAULT '[]',
    "confidence" REAL NOT NULL DEFAULT 0,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiCallAnalysis_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "AiCallRecording" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiCustomerMemory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "contactId" TEXT,
    "summary" TEXT NOT NULL DEFAULT '',
    "preferences" TEXT NOT NULL DEFAULT '{}',
    "insights" TEXT NOT NULL DEFAULT '{}',
    "source" TEXT NOT NULL DEFAULT 'ai',
    "updatedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AiCustomerMemory_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AiCustomerMemory_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "CenterContact" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiNextAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "centerId" TEXT,
    "contactId" TEXT,
    "recordingId" TEXT,
    "analysisId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "dueAt" DATETIME,
    "reason" TEXT NOT NULL DEFAULT '',
    "confidence" REAL NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'suggested',
    "approvedById" TEXT,
    "approvedAt" DATETIME,
    "executedActivityId" TEXT,
    "assignedTo" TEXT,
    "createdById" TEXT,
    "executedAt" DATETIME,
    "completedAt" DATETIME,
    "dismissedReason" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AiNextAction_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AiNextAction_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "CenterContact" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AiNextAction_assignedTo_fkey" FOREIGN KEY ("assignedTo") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiCoachInsight" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "recordingId" TEXT NOT NULL,
    "analysisId" TEXT,
    "qualityScore" INTEGER NOT NULL DEFAULT 0,
    "scores" TEXT NOT NULL DEFAULT '{}',
    "strengths" TEXT NOT NULL DEFAULT '[]',
    "improvements" TEXT NOT NULL DEFAULT '[]',
    "mistakes" TEXT NOT NULL DEFAULT '[]',
    "recommendations" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiCoachInsight_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AiCoachInsight_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "AiCallRecording" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AiCoachInsight_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "AiCallAnalysis" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiUsageLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "userId" TEXT,
    "feature" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "audioSeconds" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostRial" REAL NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'success',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AiPlaybook" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceRecordingId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
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
CREATE INDEX "SalesDocumentItem_salesDocumentId_idx" ON "SalesDocumentItem"("salesDocumentId");

-- CreateIndex
CREATE INDEX "SalesDocumentApproval_salesDocumentId_idx" ON "SalesDocumentApproval"("salesDocumentId");

-- CreateIndex
CREATE INDEX "SalesDocumentFinance_salesDocumentId_idx" ON "SalesDocumentFinance"("salesDocumentId");

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
CREATE INDEX "IssuedInvoiceItem_issuedInvoiceId_idx" ON "IssuedInvoiceItem"("issuedInvoiceId");

-- CreateIndex
CREATE INDEX "IssuedInvoicePayment_issuedInvoiceId_idx" ON "IssuedInvoicePayment"("issuedInvoiceId");

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

