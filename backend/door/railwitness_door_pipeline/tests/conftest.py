from pathlib import Path
import csv
import io
import sys
import numpy as np
import pytest
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from door_pipeline.io import ORIGINAL_HEADERS,format_timestamp,parse_timestamp

@pytest.fixture
def synthetic_csv():
    """Original tiny synthetic test fixture, not a copy of the hackathon data."""
    text=io.StringIO();w=csv.writer(text);w.writerow(ORIGINAL_HEADERS)
    base=parse_timestamp('2023-7-5-0-0-0-0')
    for cycle in range(2):
        for i in range(151):
            p=i/150;position=1000*(p if cycle==0 else 1-p)
            current=400+1100*np.sin(np.pi*p)**2
            row=[format_timestamp(base+cycle*20000+i*20),current,1500,500,
                 30,30,int(cycle==1),int(cycle==0),0,0,0,0,0,0,int(cycle==0),int(cycle==1),position]
            w.writerow(row)
    return text.getvalue().encode()
