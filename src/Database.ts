import { readDateTime } from "./data/datetime";
import { decrypt } from "./decrypt";
import { getJetFormat, JetFormat } from "./JetFormat";
import PageType, { assertPageType } from "./PageType";
import { SortOrder } from "./SortOrder";
import { uncompressText } from "./unicodeCompression";
import { xor } from "./util";

const PASSWORD_OFFSET = 0x42;

const ENCODING_KEY_OFFSET = 0x3e; // 62
const ENCODING_KEY_SIZE = 4;

export default class Database {
    public readonly format: JetFormat;

    /**
     * All 0 if the database is not encrypted
     */
    private readonly encodingKey: Buffer;

    public constructor(private readonly buffer: Buffer) {
        assertPageType(this.buffer, PageType.DatabaseDefinitionPage);

        this.format = getJetFormat(this.buffer);
        decryptHeader(this.buffer, this.format);

        // read data from decrypted page
        this.encodingKey = this.buffer.slice(ENCODING_KEY_OFFSET, ENCODING_KEY_OFFSET + ENCODING_KEY_SIZE);
    }

    public getPassword(): string | null {
        let passwordBuffer = this.buffer.slice(
            PASSWORD_OFFSET,
            PASSWORD_OFFSET + this.format.databaseDefinitionPage.passwordSize
        );

        const mask = this.getPasswordMask();
        if (mask !== null) {
            passwordBuffer = xor(passwordBuffer, mask);
        }

        if (passwordBuffer.every((b) => b === 0)) {
            return null;
        }

        let password = uncompressText(passwordBuffer, this.format);
        const nullCharIndex = password.indexOf("\0");
        if (nullCharIndex >= 0) {
            password = password.slice(0, nullCharIndex);
        }
        return password;
    }

    private getPasswordMask(): Buffer | null {
        if (this.format.databaseDefinitionPage.creationDateOffset === null) {
            return null;
        }

        const mask = Buffer.alloc(this.format.databaseDefinitionPage.passwordSize);
        const dateValue = this.buffer.readDoubleLE(this.format.databaseDefinitionPage.creationDateOffset);
        mask.writeInt32LE(Math.floor(dateValue));
        for (let i = 0; i < mask.length; ++i) {
            mask[i] = mask[i % 4];
        }
        return mask;
    }

    public getCreationDate(): Date | null {
        if (this.format.databaseDefinitionPage.creationDateOffset === null) {
            return null;
        }

        const creationDateBuffer = this.buffer.slice(
            this.format.databaseDefinitionPage.creationDateOffset,
            this.format.databaseDefinitionPage.creationDateOffset + 8
        );
        return readDateTime(creationDateBuffer);
    }

    public getDefaultSortOrder(): Readonly<SortOrder> {
        const value = this.buffer.readUInt16LE(this.format.databaseDefinitionPage.defaultSortOrder.offset + 3);

        if (value === 0) {
            return this.format.defaultSortOrder;
        }

        let version = this.format.defaultSortOrder.version;
        if (this.format.databaseDefinitionPage.defaultSortOrder.size == 4) {
            version = this.buffer.readUInt8(this.format.databaseDefinitionPage.defaultSortOrder.offset + 3);
        }

        return Object.freeze({ value, version });
    }

    public getPage(page: number): Buffer {
        const offset = page * this.format.pageSize;

        if (this.buffer.length < offset) {
            throw new Error(`Page ${page} does not exist`);
        }

        const pageBuffer = this.buffer.slice(offset, offset + this.format.pageSize);

        if (page === 0 || this.encodingKey.every((v) => v === 0)) {
            // no encryption
            return pageBuffer;
        }

        const pageIndexBuffer = Buffer.alloc(4);
        pageIndexBuffer.writeUInt32LE(page);

        const pagekey = xor(pageIndexBuffer, this.encodingKey);
        return decrypt(pageBuffer, pagekey);
    }

    /**
     * @param pageRow Lower byte contains the row number, the upper three contain page
     *
     * @see https://github.com/brianb/mdbtools/blob/d6f5745d949f37db969d5f424e69b54f0da60b9b/src/libmdb/data.c#L102-L124
     */
    public findPageRow(pageRow: number): Buffer {
        const page = pageRow >> 8;
        const row = pageRow & 0xff;

        const pageBuffer = this.getPage(page);
        return this.findRow(pageBuffer, row);
    }

    /**
     * @param pageBuffer Buffer of a data page
     *
     * @see https://github.com/brianb/mdbtools/blob/d6f5745d949f37db969d5f424e69b54f0da60b9b/src/libmdb/data.c#L126-L138
     */
    public findRow(pageBuffer: Buffer, row: number): Buffer {
        const rco = this.format.dataPage.recordCountOffset;

        if (row > 1000) {
            throw new Error("Cannot read rows > 1000"); // TODO: why?
        }

        const start = pageBuffer.readUInt16LE(rco + 2 + row * 2);
        const nextStart = row === 0 ? this.format.pageSize : pageBuffer.readUInt16LE(rco + row * 2);

        return pageBuffer.slice(start, nextStart);
    }
}

const ENCRYPTION_START = 0x18;
const ENCRYPTION_KEY = Buffer.from([0xc7, 0xda, 0x39, 0x6b]);
function decryptHeader(buffer: Buffer, format: JetFormat): void {
    const decryptedBuffer = decrypt(
        buffer.slice(ENCRYPTION_START, ENCRYPTION_START + format.databaseDefinitionPage.encryptedSize),
        ENCRYPTION_KEY
    );
    decryptedBuffer.copy(buffer, ENCRYPTION_START);
}
