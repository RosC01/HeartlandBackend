-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "type" TEXT;

-- AlterTable
ALTER TABLE "Field" ADD COLUMN     "acres" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "WorkLog" ADD COLUMN     "accountsReceivable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "acres" DOUBLE PRECISION,
ADD COLUMN     "actualRate" DOUBLE PRECISION,
ADD COLUMN     "crew" TEXT,
ADD COLUMN     "dateEnd" TIMESTAMP(3),
ADD COLUMN     "dateReceived" TIMESTAMP(3),
ADD COLUMN     "dateSent" TIMESTAMP(3),
ADD COLUMN     "invoiceSent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paymentReceived" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pitEndInches" DOUBLE PRECISION,
ADD COLUMN     "pitStartInches" DOUBLE PRECISION,
ADD COLUMN     "season" TEXT,
ADD COLUMN     "suggestedRate" DOUBLE PRECISION,
ADD COLUMN     "totalDuePerAcre" DOUBLE PRECISION,
ADD COLUMN     "waylenGallons" DOUBLE PRECISION;
