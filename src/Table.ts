import { Column, getColumnType, parseColumnFlags } from "./column";
import Database from "./Database";
import PageType, { assertPageType } from "./PageType";
import { findMapPages } from "./usage-map";
import BufferCursor from "./BufferCursor";
import { readNextString } from "./util";

export default class Table {
    private readonly definitionBuffer: Buffer;
    private readonly dataPages: number[];

    public readonly rowCount: number;
    public readonly columnCount: number;

    private readonly variableColumnCount: number;
    private readonly fixedColumnCount: number;

    private readonly logicalIndexCount: number;
    private readonly realIndexCount: number;

    /**
     * @param name Table name. As this is stored in a MSysObjects, it has to be passed in
     * @param db
     * @param firstDefinitionPage The first page of the table definition referenced in the corresponding MSysObject
     */
    public constructor(
        public readonly name: string,
        private readonly db: Database,
        private readonly firstDefinitionPage: number
    ) {
        // Concat all table definition pages
        let nextDefinitionPage = this.firstDefinitionPage;
        let buffer: Buffer | undefined;
        while (nextDefinitionPage > 0) {
            const curBuffer = this.db.getPage(nextDefinitionPage);
            assertPageType(curBuffer, PageType.TableDefinition);

            if (!buffer) {
                buffer = curBuffer;
            } else {
                buffer = Buffer.concat([buffer, curBuffer.slice(8)]);
            }

            nextDefinitionPage = curBuffer.readUInt32LE(4);
        }
        this.definitionBuffer = buffer!;

        // Read row, column, and index counts
        this.rowCount = this.definitionBuffer.readUInt32LE(
            this.db.constants.tableDefinitionPage.rowCountOffset
        );

        this.columnCount = this.definitionBuffer.readUInt32LE(
            this.db.constants.tableDefinitionPage.columnCountOffset
        );
        this.variableColumnCount = this.definitionBuffer.readUInt16LE(
            this.db.constants.tableDefinitionPage.variableColumnCountOffset
        );
        this.fixedColumnCount = this.columnCount - this.variableColumnCount;

        this.logicalIndexCount = this.definitionBuffer.readInt32LE(
            this.db.constants.tableDefinitionPage.logicalIndexCountOffset
        );
        this.realIndexCount = this.definitionBuffer.readInt32LE(
            this.db.constants.tableDefinitionPage.realIndexCountOffset
        );

        // Usage Map
        const usageMapBuffer = this.db.findPageRow(
            this.definitionBuffer.readUInt32LE(
                this.db.constants.tableDefinitionPage.usageMapOffset
            )
        );
        this.dataPages = findMapPages(usageMapBuffer);
    }

    public getColumn(name: string): Column {
        throw new Error("Method not implemented.");
    }

    public getColumns(): Column[] {
        const columns: Column[] = [];

        let curDefinitionPos =
            this.db.constants.tableDefinitionPage.realIndexStartOffset +
            this.realIndexCount *
                this.db.constants.tableDefinitionPage.realIndexEntrySize;

        const namesCursor = new BufferCursor(
            this.definitionBuffer,

            curDefinitionPos +
                this.columnCount *
                    this.db.constants.tableDefinitionPage.columnsDefinition
                        .entrySize
        );

        for (let i = 0; i < this.columnCount; ++i) {
            const columnBuffer = this.definitionBuffer.slice(
                curDefinitionPos,
                curDefinitionPos +
                    this.db.constants.tableDefinitionPage.columnsDefinition
                        .entrySize
            );

            const type = getColumnType(
                this.definitionBuffer.readUInt8(curDefinitionPos)
            );

            const column: Column = {
                name: readNextString(
                    namesCursor,
                    this.db.constants.tableDefinitionPage.columnNames
                        .nameLengthSize
                ),
                type,
                size:
                    type === "boolean"
                        ? 0
                        : columnBuffer.readUInt16LE(
                              this.db.constants.tableDefinitionPage
                                  .columnsDefinition.sizeOffset
                          ),

                pos: columnBuffer.readUInt8(
                    this.db.constants.tableDefinitionPage.columnsDefinition
                        .posOffset
                ),

                ...parseColumnFlags(
                    columnBuffer.readUInt8(
                        this.db.constants.tableDefinitionPage.columnsDefinition
                            .flagsOffset
                    )
                ),
            };

            if (type === "numeric") {
                column.precision = columnBuffer.readUInt8(11);
                column.scale = columnBuffer.readUInt8(12);
            }

            columns.push(column);

            curDefinitionPos += this.db.constants.tableDefinitionPage
                .columnsDefinition.entrySize;
        }

        columns.sort((a, b) => a.pos - b.pos);

        return columns;
    }

    public getColumnNames(): string[] {
        return this.getColumns().map((column) => column.name);
    }

    public getData(): { [column: string]: any } {
        throw new Error("Method not implemented.");
    }
}
